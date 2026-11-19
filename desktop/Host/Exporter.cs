// Exporter.cs — Export audio offline del progetto: pattern, arrangiamento o song, mix o stem.
// Usa un motore separato (stesso codice della riproduzione), quindi l'audio dal vivo non si ferma.

using System.Text.Json.Nodes;
using DrumBort.Engine;

namespace DrumBort.Host;

public static class Exporter
{
    public sealed record Options(string Source, int Reps = 4, int Rate = 48000, int Bits = 24, bool Normalize = false, double Tail = 2.5);

    static double D(JsonNode? n, string k, double def) => J.TryD(n?[k], out double d) ? d : def;
    static bool B(JsonNode? n, string k) => n?[k] is JsonValue v && (v.TryGetValue(out bool b) ? b : J.TryD(v, out double d) && d != 0);
    static int PatBars(JsonNode? p) => D(p, "bars", 1) is var b && (b == 2 || b == 4) ? (int)b : 1;

    /// <summary>Numero di step da suonare per la sorgente scelta (0 = niente da esportare).</summary>
    public static long Steps(JsonObject parts, Options o)
    {
        int slot = (int)D(parts, "slot", 0);
        switch (o.Source)
        {
            case "arr": return (parts["arr"]?["bars"] as JsonArray)?.Count * 16 ?? 0;
            case "song":
                long n = 0;
                foreach (var c in parts["song"]?["chain"] as JsonArray ?? new JsonArray())
                    n += Math.Max(1, (int)D(c, "rep", 1)) * 16L * PatBars(parts[$"p{Math.Clamp((int)D(c, "slot", 0), 0, 7)}"]);
                return n;
            default: return o.Reps * 16L * PatBars(parts[$"p{slot}"]);
        }
    }

    /// <summary>Parti pronte per la sorgente: modalità, arrangiamento e song attivati come serve.</summary>
    static JsonObject Prepare(JsonObject parts, Options o, int? only)
    {
        var p = (JsonObject)parts.DeepClone();
        // Kit, suoni e preset utente sono già registrati dal motore dal vivo (dati condivisi)
        foreach (var k in new[] { "userKits", "userPresets", "userSounds" }) p.Remove(k);
        p["mode"] = o.Source == "arr" ? "session" : "pattern";
        if (p["arr"] is JsonObject a) a["on"] = o.Source == "arr";
        if (p["song"] is JsonObject s) s["on"] = o.Source == "song";
        if (only is int ch)
            for (int i = 0; i < 8; i++)
            {
                if (p[$"p{i}"] is not JsonObject pat) continue;
                for (int t = 0; t < 8; t++) if (pat["tracks"]?[t] is JsonObject tr) { tr["solo"] = false; tr["mute"] = t != ch; }
                for (int k = 0; k < 4; k++) if (pat["synth"]?["tracks"]?[k] is JsonObject tr) { tr["solo"] = false; tr["mute"] = 8 + k != ch; }
            }
        return p;
    }

    /// <summary>Rendering stereo. `only` = un solo canale (stem), con gli effetti master.</summary>
    public static (float[] l, float[] r) Render(JsonObject parts, Options o, int? only, Action<double>? progress, CancellationToken ct)
    {
        long steps = Steps(parts, o);
        if (steps <= 0) throw new InvalidOperationException("Niente da esportare");
        var eng = new AudioEngine(o.Rate, 1024);
        eng.Ctx.Offline = true;
        eng.Seq.P.Apply(Prepare(parts, o, only));
        eng.Seq.ArrStart = 0;
        eng.Seq.StopAt = steps;
        eng.Seq.Sync();
        eng.Seq.Start();
        // Durata stimata per la barra di avanzamento (tempo del primo pattern)
        double bpm = Math.Max(40, eng.Seq.Pattern.Bpm);
        double est = steps * 15.0 / bpm + o.Tail;
        try
        {
            var (l, r) = eng.RenderSong(o.Tail, 3600, t => progress?.Invoke(Math.Min(1, t / est)), ct);
            progress?.Invoke(1);
            return (l, r);
        }
        finally { eng.Mx.DisposeDevices(); }
    }

    /// <summary>Canali con contenuto (attivi, non in mute) per gli stem.</summary>
    public static List<int> StemChannels(JsonObject parts)
    {
        var active = (parts["tracks"] as JsonArray)?.Select(x => (int)(J.TryD(x, out double d) ? d : -1)).Where(x => x >= 0).ToList() ?? new List<int>();
        if (active.Count == 0) active = Enumerable.Range(0, 12).ToList();
        bool Used(int ch)
        {
            for (int i = 0; i < 8; i++)
            {
                var p = parts[$"p{i}"];
                if (p == null) continue;
                if (ch < 8) { if (p["steps"]?[ch] is JsonArray row && row.Any(v => J.TryD(v, out double d) && d > 0) && !B(p["tracks"]?[ch], "mute")) return true; }
                else if (p["synth"]?["tracks"]?[ch - 8] is JsonObject t && !B(t, "mute") && ((t["steps"] as JsonArray)?.Any(s => s != null) == true || B(t["arp"], "on"))) return true;
            }
            return false;
        }
        return active.Where(Used).OrderBy(x => x).ToList();
    }

    public static void Normalize(float[] l, float[] r, double peakDb = -0.3)
    {
        double pk = 0;
        for (int i = 0; i < l.Length; i++) pk = Math.Max(pk, Math.Max(Math.Abs(l[i]), Math.Abs(r[i])));
        if (pk < 1e-6) return;
        float g = (float)(Math.Pow(10, peakDb / 20) / pk);
        for (int i = 0; i < l.Length; i++) { l[i] *= g; r[i] *= g; }
    }

    /// <summary>WAV stereo PCM 16/24 bit o 32 bit float.</summary>
    public static void WriteWav(string path, float[] l, float[] r, int rate, int bits)
    {
        using var w = new BinaryWriter(File.Create(path));
        int n = l.Length, bps = bits / 8, bytes = n * 2 * bps;
        w.Write("RIFF"u8); w.Write(36 + bytes); w.Write("WAVE"u8);
        w.Write("fmt "u8); w.Write(16); w.Write((short)(bits == 32 ? 3 : 1)); w.Write((short)2); w.Write(rate); w.Write(rate * 2 * bps); w.Write((short)(2 * bps)); w.Write((short)bits);
        w.Write("data"u8); w.Write(bytes);
        var rnd = new Random(1);
        for (int i = 0; i < n; i++) { Put(l[i]); Put(r[i]); }
        void Put(float v)
            {
                if (bits == 32) { w.Write(v); return; }
                double x = Math.Clamp(v, -1f, 1f);
                if (bits == 16)
                {
                    // Dither triangolare prima della riduzione a 16 bit
                    x += (rnd.NextDouble() - rnd.NextDouble()) / 32768.0;
                    w.Write((short)Math.Clamp(Math.Round(x * 32767), -32768, 32767));
                }
                else
                {
                    int s = (int)Math.Clamp(Math.Round(x * 8388607), -8388608, 8388607);
                    w.Write((byte)s); w.Write((byte)(s >> 8)); w.Write((byte)(s >> 16));
                }
            }
    }
}
