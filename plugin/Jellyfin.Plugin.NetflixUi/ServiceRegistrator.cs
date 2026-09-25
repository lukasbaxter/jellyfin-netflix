using Jellyfin.Plugin.NetflixUi.Services;
using Jellyfin.Plugin.NetflixUi.Startup;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.NetflixUi;

public class ServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<FeedService>();
        serviceCollection.AddHostedService<InjectionService>();
    }
}
