// Settings.cs — Impostazioni dell'host salvate tra un avvio e l'altro (es. uscita audio scelta).

using System.Text.Json.Nodes;

namespace DrumBort.Host;

public static class Settings
{
    static readonly string file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DrumBort", "settings.json");

    public static string? Load(string key)
    {
        try { return (JsonNode.Parse(File.ReadAllText(file)) as JsonObject)?[key]?.GetValue<string>(); }
        catch { return null; }
    }

    public static void Save(string key, string value)
    {
        try
        {
            JsonObject o;
            try { o = JsonNode.Parse(File.ReadAllText(file)) as JsonObject ?? new JsonObject(); } catch { o = new JsonObject(); }
            o[key] = value;
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, o.ToJsonString());
        }
        catch (Exception e) { Console.Error.WriteLine($"[impostazioni] {e.Message}"); }
    }
}
