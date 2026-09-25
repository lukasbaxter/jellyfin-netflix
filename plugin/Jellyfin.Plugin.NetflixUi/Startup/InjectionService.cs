using System.Reflection;
using System.Runtime.Loader;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NetflixUi.Startup;

/// <summary>
/// Registers the index.html transformation with File Transformation (by reflection, as its README shows).
/// File Transformation may finish initialising after us, so retry for a while.
/// </summary>
public class InjectionService : IHostedService, IDisposable
{
    private static readonly Guid TransformId = Guid.Parse("6e2f1c0a-9b7d-4c1e-8f3a-5d6b7c8e9f11");

    private readonly ILogger<InjectionService> _logger;
    private readonly IServerConfigurationManager _config;
    private readonly Services.FeedService _feeds;
    private CancellationTokenSource? _cts;

    public InjectionService(ILogger<InjectionService> logger, IServerConfigurationManager config, Services.FeedService feeds)
    {
        _logger = logger;
        _config = config;
        _feeds = feeds;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            string baseUrl = _config.GetNetworkConfiguration().BaseUrl?.Trim().TrimEnd('/') ?? string.Empty;
            if (baseUrl.Length > 0 && !baseUrl.StartsWith('/'))
            {
                baseUrl = "/" + baseUrl;
            }

            IndexTransformer.BaseUrl = baseUrl;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "NetflixUi: could not read base url");
        }

        _cts = new CancellationTokenSource();
        _ = Task.Run(() => RegisterLoop(_cts.Token), CancellationToken.None);
        _ = Task.Run(() => WarmUp(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _cts?.Cancel();
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _cts?.Dispose();
        GC.SuppressFinalize(this);
    }

    private async Task WarmUp(CancellationToken token)
    {
        try
        {
            // let the server finish starting before the heavier queries
            await Task.Delay(TimeSpan.FromSeconds(45), token).ConfigureAwait(false);
            _feeds.WarmTop10();
        }
        catch (TaskCanceledException)
        {
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "NetflixUi: Top 10 warm-up failed");
        }
    }

    private async Task RegisterLoop(CancellationToken token)
    {
        for (int attempt = 1; attempt <= 24 && !token.IsCancellationRequested; attempt++)
        {
            string? error = TryRegister(out bool missing);
            if (error is null)
            {
                _logger.LogInformation("NetflixUi: index.html injection registered with File Transformation (assets v={Version})", Services.AssetStore.Version);
                return;
            }

            if (missing && attempt >= 3)
            {
                _logger.LogWarning("NetflixUi: File Transformation plugin not found. Only /NetflixUi/* files are served; the branding @import still loads the theme css.");
                return;
            }

            _logger.LogDebug("NetflixUi: registration attempt {Attempt} failed: {Error}", attempt, error);
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), token).ConfigureAwait(false);
            }
            catch (TaskCanceledException)
            {
                return;
            }
        }

        _logger.LogWarning("NetflixUi: gave up registering with File Transformation");
    }

    private static string? TryRegister(out bool missing)
    {
        missing = false;
        Assembly? ft = AssemblyLoadContext.All
            .SelectMany(x => x.Assemblies)
            .FirstOrDefault(x => x.FullName?.Contains(".FileTransformation", StringComparison.Ordinal) ?? false);
        if (ft is null)
        {
            missing = true;
            return "assembly not loaded";
        }

        Type? iface = ft.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
        MethodInfo? register = iface?.GetMethod("RegisterTransformation");
        if (register is null)
        {
            return "PluginInterface.RegisterTransformation not found";
        }

        // Build the JObject with File Transformation's own Newtonsoft so the types match
        // whatever load context it lives in.
        Type jobjectType = register.GetParameters()[0].ParameterType;
        MethodInfo? parse = jobjectType.GetMethod("Parse", new[] { typeof(string) });
        if (parse is null)
        {
            return "JObject.Parse not found";
        }

        string json = System.Text.Json.JsonSerializer.Serialize(new Dictionary<string, string?>
        {
            ["id"] = TransformId.ToString(),
            ["fileNamePattern"] = "index\\.html$",
            ["callbackAssembly"] = typeof(IndexTransformer).Assembly.FullName,
            ["callbackClass"] = typeof(IndexTransformer).FullName,
            ["callbackMethod"] = nameof(IndexTransformer.TransformIndex),
        });

        try
        {
            object? payload = parse.Invoke(null, new object[] { json });
            register.Invoke(null, new[] { payload });
            return null;
        }
        catch (TargetInvocationException ex)
        {
            return ex.InnerException?.Message ?? ex.Message;
        }
    }
}
