// Server.cs — Server HTTP/WebSocket dell'host (condiviso da DrumBortHost e dall'app Windows):
// web app per i telefoni, hub WebSocket, stato del motore, collegamento del telefono (QR),
// scelta dell'uscita audio.

using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using QRCoder;

namespace DrumBort.Host;

public static class Server
{
    public static IEnumerable<string> LanAddresses() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a.Address))
            .Select(a => a.Address.ToString())
            .Distinct();

    /// <summary>Indirizzo per il telefono (prima rete locale), null se il PC non è in rete.</summary>
    public static string? PhoneUrl(int port) => LanAddresses().FirstOrDefault() is { } ip ? $"http://{ip}:{port}/" : null;

    /// <summary>QR code dell'indirizzo per il telefono in PNG.</summary>
    public static byte[]? PhoneQrPng(int port, int pixels = 10)
    {
        var url = PhoneUrl(port);
        if (url == null) return null;
        using var qr = new QRCodeGenerator().CreateQrCode(url, QRCodeGenerator.ECCLevel.M);
        return new PngByteQRCode(qr).GetGraphic(pixels);
    }

    /// <summary>Crea il server (non ancora avviato).</summary>
    public static WebApplication Build(string[] args, AudioEngine? engine, Hub hub, int port, string baseDir, bool realAudio)
    {
        var builder = WebApplication.CreateSlimBuilder(args);
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
        var app = builder.Build();
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) });

        string web = Path.Combine(baseDir, "wwwroot");
        string meta = $"<meta name=\"drumbort-host\" content=\"{(hub.Native ? "native" : "browser")}\">";
        async Task Index(HttpContext ctx)
        {
            var html = await File.ReadAllTextAsync(Path.Combine(web, "index.html"));
            html = html.Replace("<head>", "<head>\n  " + meta);
            ctx.Response.ContentType = "text/html; charset=utf-8";
            ctx.Response.Headers.CacheControl = "no-store";
            await ctx.Response.WriteAsync(html);
        }
        app.MapGet("/", Index);
        app.MapGet("/index.html", Index);
        app.Map("/ws", hub.Handle);
        app.MapGet("/host.json", () => Results.Json(new
        {
            native = hub.Native, clients = hub.Count, version = typeof(Hub).Assembly.GetName().Version?.ToString(3),
            engine = engine?.Status(),
        }));
        // Collegamento del telefono: indirizzi nella rete locale e QR code (menu "Collega telefono")
        app.MapGet("/connect.json", () => Results.Json(new { urls = LanAddresses().Select(ip => $"http://{ip}:{port}/").ToArray() }));
        app.MapGet("/qr.svg", () =>
        {
            var url = PhoneUrl(port);
            if (url == null) return Results.NotFound();
            using var qr = new QRCodeGenerator().CreateQrCode(url, QRCodeGenerator.ECCLevel.M);
            return Results.Content(new SvgQRCode(qr).GetGraphic(8), "image/svg+xml");
        });
        // Uscita audio del motore nativo: elenco, scelta, nuova lettura dei dispositivi
        app.MapGet("/audio", () => !realAudio ? Results.Json(new { available = false }) : Results.Json(new
        {
            available = true, current = engine!.CurrentDevice, follow = engine.FollowDefault,
            devices = engine.Devices().Select(d => new { d.name, d.isDefault }),
        }));
        app.MapPost("/audio", async (HttpContext ctx) =>
        {
            if (!realAudio) return Results.Json(new { available = false });
            var body = await JsonNode.ParseAsync(ctx.Request.Body) as JsonObject;
            string? name = body?["device"]?.GetValue<string>();
            bool refresh = body?["refresh"]?.GetValue<bool>() ?? false;
            try
            {
                if (refresh) engine!.Refresh();
                else engine!.SelectDevice(name);
                return Results.Json(new { available = true, current = engine.CurrentDevice, follow = engine.FollowDefault });
            }
            catch (Exception e) { return Results.Json(new { available = true, error = e.Message }, statusCode: 500); }
        });
        if (engine != null) engine.DeviceChanged += (name) => _ = hub.Broadcast(new JsonObject { ["t"] = "audio", ["device"] = name });
        var types = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
        types.Mappings[".webmanifest"] = "application/manifest+json";
        app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(web),
            ContentTypeProvider = types,
            OnPrepareResponse = c => c.Context.Response.Headers.CacheControl = "no-store",
        });
        return app;
    }
}
