// Program.cs — DrumBort per Windows: avvia il motore audio C#, il server per i telefoni e
// la finestra nativa (WPF).
//
//   DrumBort.exe                     avvio normale
//   DrumBort.exe --no-audio          senza scheda audio (prove)
//   DrumBort.exe --port 9000         porta per i telefoni (predefinita 8765, poi le successive)
//   DrumBort.exe --selftest out.png  apre la finestra con un progetto di prova, la salva in PNG ed esce

using System.Net;
using Microsoft.Extensions.Hosting;
using System.Net.Sockets;
using System.Windows;
using DrumBort.Engine;
using DrumBort.Host;

namespace DrumBort.Win;

public static class Program
{
    public static string DataDir = "";
    public static AudioEngine? Engine;
    public static Hub Hub = null!;
    public static WebApplication? Web;
    public static int Port;
    public static bool RealAudio;

    [STAThread]
    public static int Main(string[] args)
    {
        string Arg(string n, string d) { int i = Array.IndexOf(args, n); return i >= 0 && i + 1 < args.Length ? args[i + 1] : d; }
        bool Flag(string n) => args.Contains(n);
        string? selftest = Flag("--selftest") ? Arg("--selftest", "selftest.png") : null;

        DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DrumBort");
        Directory.CreateDirectory(DataDir);
        try
        {
            var log = new StreamWriter(Path.Combine(DataDir, "drumbort.log"), false) { AutoFlush = true };
            Console.SetOut(log); Console.SetError(log);
        }
        catch { /* registro facoltativo */ }

        string baseDir = AppContext.BaseDirectory;
        Kits.Load(File.ReadAllText(Path.Combine(baseDir, "Assets", "kits.json")));
        Synth.Load(File.ReadAllText(Path.Combine(baseDir, "Assets", "presets.json")));

        // Motore audio nativo
        bool noAudio = Flag("--no-audio") || selftest != null;
        int rate = int.Parse(Arg("--rate", "48000"));
        if (!noAudio && !Flag("--rate")) rate = AudioEngine.PreferredRate(rate);
        Engine = new AudioEngine(rate, int.Parse(Arg("--buffer", "1024")));
        try
        {
            if (noAudio) Engine.StartVirtual(); else Engine.Start();
            RealAudio = !noAudio;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"Audio non disponibile: {e.Message}");
            try { Engine.StartVirtual(); } catch { }
            RealAudio = false;
            if (selftest == null) MessageBox.Show($"Scheda audio non disponibile:\n{e.Message}\n\nDrumBort si apre senza audio.", "DrumBort", MessageBoxButton.OK, MessageBoxImage.Warning);
        }

        // Server per i telefoni (porta libera a partire da quella richiesta)
        Hub = new Hub(Engine);
        Port = FreePort(int.Parse(Arg("--port", "8765")));
        try
        {
            Web = Server.Build(Array.Empty<string>(), Engine, Hub, Port, baseDir, RealAudio);
            Web.Start();
            Console.WriteLine($"Telefono: {Server.PhoneUrl(Port) ?? "(nessuna rete)"}");
        }
        catch (Exception e) { Console.Error.WriteLine($"Server per i telefoni non avviato: {e.Message}"); Web = null; }

        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        app.DispatcherUnhandledException += (_, e) =>
        {
            Console.Error.WriteLine(e.Exception.ToString());
            if (selftest == null) MessageBox.Show(e.Exception.Message, "DrumBort — errore", MessageBoxButton.OK, MessageBoxImage.Error);
            else Environment.Exit(3);
            e.Handled = true;
        };
        var win = new MainWindow(selftest);
        int code = app.Run(win);

        try { Web?.StopAsync().Wait(TimeSpan.FromSeconds(2)); } catch { }
        Engine?.Dispose();
        return code;
    }

    static int FreePort(int start)
    {
        for (int p = start; p < start + 20; p++)
        {
            try { var l = new TcpListener(IPAddress.Any, p); l.Start(); l.Stop(); return p; }
            catch (SocketException) { }
        }
        return start;
    }
}
