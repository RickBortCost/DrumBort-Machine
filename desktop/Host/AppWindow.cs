// AppWindow.cs — Finestra di programma nativa per l'interfaccia (niente browser):
// Photino con il motore web del sistema (WebView2 su Windows, WKWebView su macOS,
// WebKitGTK su Linux). Chiudendo la finestra si chiude il programma.
// Più: console di Windows (il programma non ne apre una, ma si collega a quella del terminale
// da cui viene lanciato) e registro su file.

using System.Runtime.InteropServices;
using System.Text;
using Photino.NET;

namespace DrumBort.Host;

public static class AppWindow
{
    /// <summary>
    /// Mostra la finestra e attende la chiusura. false se il sistema non ha il componente
    /// WebView necessario (es. Linux senza WebKitGTK): si usa allora la finestra del browser.
    /// </summary>
    public static bool Run(string url, string title)
    {
        bool shown = false;
        Exception? err = null;
        void Body()
        {
            try
            {
                var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DrumBort", "webview");
                Directory.CreateDirectory(data);
                var w = new PhotinoWindow()
                    .SetLogVerbosity(0)
                    .SetTitle(title)
                    .SetUseOsDefaultSize(false)
                    .SetSize(1440, 900)
                    .SetMinSize(1000, 640)
                    .SetResizable(true)
                    .SetTemporaryFilesPath(data)
                    .SetContextMenuEnabled(false)
                    .SetDevToolsEnabled(false)
                    .SetGrantBrowserPermissions(true)
                    .Center();
                w.WindowCreated += (_, _) => shown = true;
                w.Load(new Uri(url));
                w.WaitForClose();
            }
            catch (Exception e) { err = e; }
        }
        // Windows: la finestra (WebView2, COM) vuole un thread STA; macOS: il thread principale
        if (OperatingSystem.IsWindows())
        {
            var t = new Thread(Body) { Name = "DrumBort window" };
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
        }
        else Body();
        if (err != null) Console.Error.WriteLine($"Finestra nativa non disponibile ({err.GetType().Name}: {err.Message}{(err.InnerException != null ? " — " + err.InnerException.Message : "")}).");
        return shown || err == null;
    }

    // ---------------------------------------------------------------- console e registro
    [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);

    /// <summary>
    /// L'eseguibile Windows è un programma a finestre (nessuna console all'avvio con doppio clic).
    /// Lanciato da un terminale si collega alla sua console; l'output va anche in DrumBort/host.log.
    /// </summary>
    public static void SetupConsole()
    {
        if (OperatingSystem.IsWindows() && !Console.IsOutputRedirected && AttachConsole(-1))
        {
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError()) { AutoFlush = true });
            Console.WriteLine();
        }
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DrumBort");
            Directory.CreateDirectory(dir);
            var log = new StreamWriter(Path.Combine(dir, "host.log"), false, Encoding.UTF8) { AutoFlush = true };
            Console.SetOut(new Tee(Console.Out, log));
            Console.SetError(new Tee(Console.Error, log));
        }
        catch { /* registro facoltativo */ }
    }

    sealed class Tee : TextWriter
    {
        readonly TextWriter a, b;
        public Tee(TextWriter a, TextWriter b) { this.a = a; this.b = b; }
        public override Encoding Encoding => a.Encoding;
        public override void Write(char value) { lock (b) { try { a.Write(value); } catch { } b.Write(value); } }
        public override void Write(string? value) { lock (b) { try { a.Write(value); } catch { } b.Write(value); } }
        public override void WriteLine(string? value) { lock (b) { try { a.WriteLine(value); } catch { } b.WriteLine(value); } }
        public override void Flush() { try { a.Flush(); } catch { } b.Flush(); }
    }
}
