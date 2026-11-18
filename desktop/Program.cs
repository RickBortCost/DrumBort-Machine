// Program.cs — DrumBort Host: serve la web app sulla rete locale, collega i dispositivi via
// WebSocket e (modalità nativa) genera l'audio con il motore C#.
//
//   DrumBortHost                       motore nativo, porta 8765
//   DrumBortHost --mode browser        relay: l'audio lo produce il browser del PC
//   DrumBortHost --port 9000 --device 3 --buffer 512 --rate 44100
//   DrumBortHost --no-audio                motore nativo senza scheda audio (test, server)
//   DrumBortHost --no-browser              non apre la finestra dell'interfaccia
//   DrumBortHost --list-devices
//   DrumBortHost --render-voices out.json     (test: picco/RMS di ogni voce, offline)
//   DrumBortHost --render project.json 8 out.wav   (test: rendering offline di un progetto)

using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json.Nodes;
using DrumBort.Audio;
using DrumBort.Engine;
using DrumBort.Host;
using QRCoder;

string Arg(string name, string def)
{
    int i = Array.IndexOf(args, name);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : def;
}
bool Flag(string name) => args.Contains(name);

string baseDir = AppContext.BaseDirectory;
Kits.Load(File.ReadAllText(Path.Combine(baseDir, "Assets", "kits.json")));
Synth.Load(File.ReadAllText(Path.Combine(baseDir, "Assets", "presets.json")));
int rate = int.Parse(Arg("--rate", "48000"));

if (Flag("--list-devices")) { AudioEngine.ListDevices(); return; }
if (Flag("--render-voices")) { Tools.RenderVoices(Arg("--render-voices", "voices.json"), rate); return; }
if (Flag("--render"))
{
    int i = Array.IndexOf(args, "--render");
    Tools.RenderProject(args[i + 1], double.Parse(args[i + 2], System.Globalization.CultureInfo.InvariantCulture), args[i + 3], rate);
    return;
}

int port = int.Parse(Arg("--port", "8765"));
bool native = Arg("--mode", "native") != "browser";
AudioEngine? engine = null;
if (native)
{
    engine = new AudioEngine(rate, int.Parse(Arg("--buffer", "1024")));
    try
    {
        if (Flag("--no-audio")) engine.StartVirtual();
        else engine.Start(int.Parse(Arg("--device", "-1")));
    }
    catch (Exception e)
    {
        Console.Error.WriteLine($"Audio non disponibile ({e.Message}). Avvio in modalità browser (relay).");
        engine.Dispose();
        engine = null;
    }
}
var hub = new Hub(engine);

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
// Uscita audio del motore nativo: elenco, scelta, nuova lettura dei dispositivi
bool realAudio = engine != null && !Flag("--no-audio");
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

app.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine($"DrumBort Host — motore: {(hub.Native ? "nativo C#" : "browser (relay)")}");
    Console.WriteLine($"PC:       http://localhost:{port}/");
    var ips = LanAddresses().ToList();
    foreach (var ip in ips) Console.WriteLine($"Telefono: http://{ip}:{port}/");
    if (ips.Count > 0 && !Flag("--no-qr"))
    {
        using var qr = new QRCodeGenerator().CreateQrCode($"http://{ips[0]}:{port}/", QRCodeGenerator.ECCLevel.L);
        Console.WriteLine(new AsciiQRCode(qr).GetGraphic(1, "██", "  "));
        Console.WriteLine("Inquadra il QR con il telefono (stessa rete Wi-Fi).");
    }
    if (!Flag("--no-browser"))
    {
        // Finestra dell'interfaccia: chiudendola si chiude anche l'host
        var win = Launcher.Open($"http://localhost:{port}/");
        if (win != null)
        {
            Console.WriteLine("Chiudi la finestra di DrumBort (o questa console) per uscire.");
            Task.Run(async () =>
            {
                await win.WaitForExitAsync();
                // Edge/Chrome già aperti con lo stesso profilo: il processo lanciato termina subito, l'host resta attivo
                if (DateTime.Now - win.StartTime > TimeSpan.FromSeconds(5)) app.Lifetime.StopApplication();
            });
        }
    }
});
Console.CancelKeyPress += (_, _) => engine?.Dispose();
app.Run();
engine?.Dispose();

static IEnumerable<string> LanAddresses() =>
    NetworkInterface.GetAllNetworkInterfaces()
        .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
        .SelectMany(n => n.GetIPProperties().UnicastAddresses)
        .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a.Address))
        .Select(a => a.Address.ToString())
        .Distinct();
