// Launcher.cs — Apre l'interfaccia (la web app servita dall'host) in una finestra dedicata:
// Edge/Chrome in modalità "app" (senza barre del browser) con un profilo separato, così la
// finestra si comporta come un programma; chiudendola si chiude anche l'host.
// Se nessuno dei due è installato si usa il browser predefinito.

using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DrumBort.Host;

public static class Launcher
{
    static IEnumerable<string> Candidates()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            foreach (var root in new[] { Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("LOCALAPPDATA") })
            {
                if (string.IsNullOrEmpty(root)) continue;
                yield return Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe");
                yield return Path.Combine(root, "Google", "Chrome", "Application", "chrome.exe");
            }
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            yield return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
            yield return "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
            yield return "/Applications/Chromium.app/Contents/MacOS/Chromium";
        }
        else
        {
            foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(':'))
                foreach (var n in new[] { "google-chrome", "chromium", "chromium-browser", "microsoft-edge" })
                    yield return Path.Combine(dir, n);
        }
    }

    /// <summary>Apre la finestra; restituisce il processo se è una finestra dedicata (per legarne la chiusura all'host).</summary>
    public static Process? Open(string url)
    {
        var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DrumBort", "window");
        foreach (var exe in Candidates())
        {
            if (!File.Exists(exe)) continue;
            try
            {
                Directory.CreateDirectory(profile);
                var psi = new ProcessStartInfo(exe) { UseShellExecute = false };
                psi.ArgumentList.Add($"--app={url}");
                psi.ArgumentList.Add($"--user-data-dir={profile}");
                psi.ArgumentList.Add("--window-size=1440,900");
                psi.ArgumentList.Add("--no-first-run");
                psi.ArgumentList.Add("--no-default-browser-check");
                psi.ArgumentList.Add("--autoplay-policy=no-user-gesture-required");
                var p = Process.Start(psi);
                if (p != null) { Console.WriteLine($"Interfaccia aperta in una finestra ({Path.GetFileNameWithoutExtension(exe)})."); return p; }
            }
            catch { /* prova il successivo */ }
        }
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            Console.WriteLine("Interfaccia aperta nel browser predefinito.");
        }
        catch
        {
            Console.WriteLine($"Apri l'interfaccia nel browser: {url}");
        }
        return null;
    }
}
