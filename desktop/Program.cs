// Program.cs — DrumBort Host: serve la web app sulla rete locale, collega i dispositivi via
// WebSocket e (modalità nativa) genera l'audio con il motore C#.
//
//   DrumBortHost                       motore nativo, porta 8765
//   DrumBortHost --mode browser        relay: l'audio lo produce il browser del PC
//   DrumBortHost --port 9000 --device 3 --buffer 512 --rate 44100
//   DrumBortHost --no-audio                motore nativo senza scheda audio (test, server)
//   DrumBortHost --no-browser              non apre la finestra dell'interfaccia
//   DrumBortHost --browser-window          interfaccia in Edge/Chrome invece della finestra nativa
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

AppWindow.SetupConsole();

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

if (Flag("--tweak-test")) { Environment.Exit(Tools.TweakTest(rate)); }
if (Flag("--bench-wt")) { Tools.BenchWavetable(rate, int.Parse(Arg("--reps", "3"))); return; }
if (Flag("--vst3-test")) { Environment.Exit(Tools.Vst3Test(Arg("--vst3-test", "."))); }
if (Flag("--export"))
{
    // --export progetto.json uscita.wav [--source pattern|arr|song] [--reps 4] [--bits 24] [--stems]
    int i = Array.IndexOf(args, "--export");
    Tools.ExportProject(args[i + 1], args[i + 2], new Exporter.Options(Arg("--source", "pattern"), int.Parse(Arg("--reps", "4")), rate, int.Parse(Arg("--bits", "24"))), Flag("--stems"));
    return;
}

int port = int.Parse(Arg("--port", "8765"));
bool native = Arg("--mode", "native") != "browser";
AudioEngine? engine = null;
if (native)
{
    // Frequenza nativa del dispositivo (niente conversione del sistema), salvo --rate
    if (!args.Contains("--rate") && !Flag("--no-audio")) rate = AudioEngine.PreferredRate(rate);
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

bool realAudio = engine != null && !Flag("--no-audio");
var app = Server.Build(args, engine, hub, port, baseDir, realAudio);

app.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine($"DrumBort Host — motore: {(hub.Native ? "nativo C#" : "browser (relay)")}");
    Console.WriteLine($"PC:       http://localhost:{port}/");
    var ips = Server.LanAddresses().ToList();
    foreach (var ip in ips) Console.WriteLine($"Telefono: http://{ip}:{port}/");
    if (ips.Count > 0 && !Flag("--no-qr"))
    {
        using var qr = new QRCodeGenerator().CreateQrCode($"http://{ips[0]}:{port}/", QRCodeGenerator.ECCLevel.L);
        Console.WriteLine(new AsciiQRCode(qr).GetGraphic(1, "██", "  "));
        Console.WriteLine("Inquadra il QR con il telefono (stessa rete Wi-Fi).");
    }
});
Console.CancelKeyPress += (_, _) => engine?.Dispose();
app.Start();

string ui = $"http://localhost:{port}/";
bool done = false;
if (!Flag("--no-browser") && !Flag("--browser-window"))
{
    // Finestra di programma nativa: chiudendola si chiude il programma
    done = AppWindow.Run(ui + "?app", $"DrumBort Machine {typeof(Hub).Assembly.GetName().Version?.ToString(3)}");
    if (done) app.StopAsync().Wait(TimeSpan.FromSeconds(3));
}
if (!done)
{
    if (!Flag("--no-browser"))
    {
        // Ripiego: Edge/Chrome in modalità app (chiudendola si chiude anche l'host)
        var win = Launcher.Open(ui);
        if (win != null)
        {
            Console.WriteLine("Chiudi la finestra di DrumBort per uscire.");
            _ = Task.Run(async () =>
            {
                await win.WaitForExitAsync();
                // Edge/Chrome già aperti con lo stesso profilo: il processo lanciato termina subito, l'host resta attivo
                if (DateTime.Now - win.StartTime > TimeSpan.FromSeconds(5)) app.Lifetime.StopApplication();
            });
        }
    }
    app.WaitForShutdown();
}
engine?.Dispose();
