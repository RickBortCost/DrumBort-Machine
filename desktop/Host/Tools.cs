// Tools.cs — Rendering offline per i test: misure delle voci e rendering di un progetto in WAV.

using System.Text.Json;
using System.Text.Json.Nodes;
using DrumBort.Audio;
using DrumBort.Engine;

namespace DrumBort.Host;

public static class Tools
{
    /// <summary>Picco e RMS di ogni voce di batteria e di ogni preset synth (render offline isolato).</summary>
    /// <summary>Benchmark del synth wavetable: ogni preset come accordo di 3 note (2 s), tempo per preset.</summary>
    public static void BenchWavetable(int rate, int reps)
    {
        double total = 0, audio = 0;
        var rows = new List<(string id, double ms)>();
        foreach (var (id, pr) in Synth.Presets.Where(x => x.Value.Wt != null))
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            for (int k = 0; k < reps; k++)
            {
                var ctx = new AudioContext(rate);
                var vp = new VoiceParams(0, 0, 1, 1, 1, 1, 1, 1, 0, 120);
                Synth.PlayVoice(ctx, ctx.Destination, 0.01, 2, new[] { 48, 52, 55 }, 0.9, pr, vp, null);
                var l = new float[AudioContext.Block]; var r = new float[AudioContext.Block];
                for (int f = 0; f < rate * 2.5; f += AudioContext.Block) ctx.RenderBlock(l, r, 0);
                audio += 2.5;
            }
            double ms = sw.Elapsed.TotalMilliseconds / reps;
            total += ms; rows.Add((id, ms));
        }
        foreach (var (id, ms) in rows.OrderByDescending(x => x.ms)) Console.WriteLine($"{id,-16} {ms,7:0.0} ms per 2,5 s ({2500 / ms,5:0}× tempo reale)");
        Console.WriteLine($"TOTALE {total:0} ms · media {2500 * rows.Count / total:0}× tempo reale per voce (accordo di 3 note)");
        Profiler.Report();
    }

    public static void RenderVoices(string outPath, int rate)
    {
        var res = new JsonObject();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        double audioSec = 0;
        foreach (var kit in Kits.All)
        {
            for (int i = 0; i < kit.Tracks.Length; i++)
            {
                var ctx = new AudioContext(rate);
                kit.Tracks[i].Play(ctx, ctx.Destination, 0.01, 1, 0, 1);
                res[$"d|{kit.Id}|{kit.Tracks[i].Short}"] = Measure(ctx, 3);
                audioSec += 3;
            }
        }
        foreach (var (id, pr) in Synth.Presets)
        {
            var ctx = new AudioContext(rate);
            bool chord = new[] { "Pad", "Strings", "Choir", "Organ", "Keys", "Piano" }.Any(c => c == CatOf(id));
            int[] notes = chord ? new[] { 57, 60, 64 } : new[] { CatOf(id) == "Bass" ? 45 : 69 };
            var vp = new VoiceParams(0, 0, 1, 1, 1, 1, 1, 1, 0, 120);
            Synth.PlayVoice(ctx, ctx.Destination, 0.01, Math.Max(0.4, pr.A * 1.1), notes, 1, pr, vp, notes[0] - 5);
            res[$"s|{id}"] = Measure(ctx, 3);
            audioSec += 3;
        }
        res["_speed"] = Math.Round(audioSec / sw.Elapsed.TotalSeconds, 1);
        res["_comp"] = CompressorProbe(rate);
        res["_rev"] = ReverbProbe(rate);
        res["_eq"] = EqProbe(rate);
        File.WriteAllText(outPath, res.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"{res.Count - 1} voci → {outPath} ({audioSec / sw.Elapsed.TotalSeconds:0}× tempo reale)");
    }

    /// <summary>Curva e transitorio del compressore (confronto con Chrome, vedi tests/desktop-compare.mjs).</summary>
    public static JsonObject CompressorProbe(int rate)
    {
        var res = new JsonObject();
        foreach (var amp in new[] { 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2 })
        {
            var ctx = new AudioContext(rate);
            var o = ctx.Oscillator(); var g = ctx.Gain((float)amp); var c = new CompressorNode(ctx);
            o.Connect(g).Connect(c).Connect(ctx.Destination); o.Start(0);
            var l = new float[AudioContext.Block]; var r = new float[AudioContext.Block];
            double pk = 0;
            for (int f = 0; f < rate; f += AudioContext.Block) { ctx.RenderBlock(l, r, 0); if (f >= rate / 2) foreach (var v in l) pk = Math.Max(pk, Math.Abs(v)); }
            res[$"{amp}"] = Math.Round(pk / amp, 3);
        }
        {
            var ctx = new AudioContext(rate);
            var o = ctx.Oscillator(); var g = ctx.Gain(); var c = new CompressorNode(ctx);
            g.GainParam.SetValueAtTime(0, 0); g.GainParam.SetValueAtTime(0.5f, 0.1); g.GainParam.SetTargetAtTime(0, 0.1, 0.03);
            o.Connect(g).Connect(c).Connect(ctx.Destination); o.Start(0);
            var l = new float[AudioContext.Block]; var r = new float[AudioContext.Block];
            double pk = 0, s = 0; int n = 0;
            for (int f = 0; f < rate; f += AudioContext.Block)
            {
                ctx.RenderBlock(l, r, 0);
                for (int i = 0; i < AudioContext.Block; i++) if (f + i >= rate / 10 && f + i < rate / 10 + rate * 3 / 10) { pk = Math.Max(pk, Math.Abs(l[i])); s += l[i] * l[i]; n++; }
            }
            res["burstPeak"] = Math.Round(pk, 3); res["burstRms"] = Math.Round(Math.Sqrt(s / n), 4);
        }
        return res;
    }

    /// <summary>Rullante 909 con mandata riverbero piena, senza compressore: RMS a finestre (come il test web).</summary>
    public static JsonObject ReverbProbe(int rate)
    {
        var res = new JsonObject();
        foreach (var size in new[] { 1.0, 2.2, 4.0 })
        {
            var ctx = new AudioContext(rate);
            var mx = new Mixer(ctx);
            mx.BypassCompressor();
            var kit = Kits.ById("tr909");
            mx.SetKit(kit);
            var fx = new Fx { Size = size };
            mx.SetFx(fx, 120, true);
            var pat = Pattern.Parse(null);
            pat.Tracks[1].Rev = 1;
            mx.ApplyMix(pat, 0);
            mx.Trigger(1, 0.03, 1, pat.Tracks[1], kit);
            int frames = rate * 3;
            var L = new float[frames]; var R = new float[frames];
            for (int f = 0; f < frames; f += AudioContext.Block) { ctx.RenderBlock(L, R, f); mx.AfterBlock(); }
            double Win(double a, double z) { double s = 0; int n = 0; for (int i = (int)(a * rate); i < (int)(z * rate); i++) { s += L[i] * L[i] + R[i] * R[i]; n += 2; } return Math.Sqrt(s / n); }
            res[$"{size}"] = new JsonArray(new[] { Win(0.02, 0.3), Win(0.4, 0.8), Win(0.8, 1.4), Win(1.4, 2.2), Win(2.2, 2.99) }.Select(x => (JsonNode)double.Parse(x.ToString("E3"))).ToArray());
        }
        return res;
    }

    /// <summary>Guadagno dei filtri shelf (EQ per traccia) su sinusoidi di prova.</summary>
    public static JsonObject EqProbe(int rate)
    {
        var res = new JsonObject();
        foreach (var (type, fc, g) in new[] { ("lowshelf", 200.0, 6.0), ("highshelf", 5000.0, -9.0), ("peaking", 1000.0, 8.0) })
            foreach (var f in new[] { 60.0, 200.0, 1000.0, 5000.0, 12000.0 })
            {
                var ctx = new AudioContext(rate);
                var o = ctx.Oscillator(); o.Frequency.Value = (float)f;
                var bq = ctx.Biquad(type); bq.Frequency.Value = (float)fc; bq.GainParam.Value = (float)g;
                o.Connect(ctx.Gain(0.5f)).Connect(bq).Connect(ctx.Destination); o.Start(0);
                var l = new float[AudioContext.Block]; var r = new float[AudioContext.Block];
                double pk = 0;
                for (int k = 0; k < rate; k += AudioContext.Block) { ctx.RenderBlock(l, r, 0); if (k >= rate / 2) foreach (var v in l) pk = Math.Max(pk, Math.Abs(v)); }
                res[$"{type}|{f}"] = Math.Round(20 * Math.Log10(pk / 0.5), 2);
            }
        return res;
    }

    static readonly Dictionary<string, string> cats = new();
    static string CatOf(string id)
    {
        if (cats.Count == 0)
        {
            var raw = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Assets", "presets.json")))!.AsObject();
            foreach (var (k, v) in raw) cats[k] = J.S(v, "cat", "");
        }
        return cats.TryGetValue(id, out var c) ? c : "";
    }

    static JsonObject Measure(AudioContext ctx, double seconds)
    {
        int frames = (int)(seconds * ctx.SampleRate);
        var l = new float[AudioContext.Block]; var r = new float[AudioContext.Block];
        double pk = 0, sum = 0; int n = 0; bool nan = false;
        var env = new List<double>();   // RMS ogni 10 ms
        double es = 0; int en = 0, win = ctx.SampleRate / 100;
        for (int f = 0; f < frames; f += AudioContext.Block)
        {
            ctx.RenderBlock(l, r, 0);
            for (int i = 0; i < AudioContext.Block; i++)
            {
                float v = l[i];
                if (float.IsNaN(v)) nan = true;
                pk = Math.Max(pk, Math.Abs(v)); sum += v * v; n++;
                es += v * v; if (++en == win) { env.Add(Math.Sqrt(es / en)); es = 0; en = 0; }
            }
        }
        return new JsonObject
        {
            ["peak"] = Math.Round(pk, 4), ["rms"] = Math.Round(Math.Sqrt(sum / n), 5), ["nan"] = nan,
            ["env"] = new JsonArray(env.Take(150).Select(x => (JsonNode)Math.Round(x, 4)).ToArray()),
        };
    }

    /// <summary>Prova dell'host VST 3: classi, parametri, valore leggibile, stato salvato e ricaricato.</summary>
    public static int Vst3Test(string path)
    {
        if (!Vst3.Available) { Console.WriteLine("vst3: libreria non disponibile"); return 2; }
        var dir = Directory.Exists(path) && !path.EndsWith(".vst3") ? path : Path.GetDirectoryName(Path.GetFullPath(path))!;
        var found = Vst3.Scan(new[] { dir }).Where(p => path == dir || Path.GetFullPath(p.Path) == Path.GetFullPath(path)).ToList();
        foreach (var f in found) Console.WriteLine($"vst3: {f.Name} · {f.Vendor} · {f.Sub} · {Path.GetFileName(f.Path)}");
        if (found.Count == 0) { Console.WriteLine("vst3: nessun effetto trovato"); return 3; }
        using var pl = Vst3.Plugin.Open(found[0].Path, found[0].Cid, 48000, 128);
        var ps = pl.Params();
        foreach (var p in ps.Take(8)) Console.WriteLine($"  {p.Id} {p.Name} = {pl.Text(p.Id, pl.Get(p.Id))} {p.Units}");
        if (ps.FirstOrDefault(p => p.Steps == 0) is Vst3.Param p0)
        {
            pl.Set(p0.Id, 0.25);
            var buf = new float[128];
            pl.Process(buf, buf, new float[128], new float[128], 128);
            string st = pl.GetState();
            pl.Set(p0.Id, 0.9);
            pl.SetState(st);
            double back = pl.Get(p0.Id);
            Console.WriteLine($"vst3: stato {st.Length} caratteri, {p0.Name} dopo il ripristino = {back:0.000}");
            if (Math.Abs(back - 0.25) > 0.01) { Console.WriteLine("vst3: lo stato non è stato ripristinato"); return 4; }
        }
        Console.WriteLine("vst3 ok");
        return 0;
    }

    /// <summary>Export da riga di comando (come FILE ▸ Esporta audio): mix o stem.</summary>
    public static void ExportProject(string projectPath, string wavPath, Exporter.Options o, bool stems)
    {
        var json = JsonNode.Parse(File.ReadAllText(projectPath))!.AsObject();
        var parts = new JsonObject();
        if (json["slots"] is JsonArray slots) for (int i = 0; i < slots.Count && i < 8; i++) parts[$"p{i}"] = slots[i]?.DeepClone();
        foreach (var k in new[] { "slot", "fx", "song", "lock", "session", "arr", "devs", "tracks", "buses" })
            if (json[k] != null) parts[k] = json[k]!.DeepClone();
        foreach (int? ch in stems ? Exporter.StemChannels(parts).Select(c => (int?)c) : new int?[] { null })
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var (l, r) = Exporter.Render(parts, o, ch, null, CancellationToken.None);
            string path = ch is int c ? Path.Combine(Path.GetDirectoryName(Path.GetFullPath(wavPath))!, $"{Path.GetFileNameWithoutExtension(wavPath)}-{c:00}.wav") : wavPath;
            Exporter.WriteWav(path, l, r, o.Rate, o.Bits);
            double pk = 0; foreach (var v in l) pk = Math.Max(pk, Math.Abs(v));
            Console.WriteLine($"{path}: {l.Length / (double)o.Rate:0.00} s, peak {pk:0.000}, {sw.Elapsed.TotalSeconds:0.0} s");
        }
    }

    /// <summary>Rendering offline di un progetto esportato dalla web app (play dal pattern selezionato).</summary>
    public static void RenderProject(string projectPath, double seconds, string wavPath, int rate)
    {
        var json = JsonNode.Parse(File.ReadAllText(projectPath))!.AsObject();
        var parts = new JsonObject();
        if (json["slots"] is JsonArray slots) for (int i = 0; i < slots.Count && i < 8; i++) parts[$"p{i}"] = slots[i]?.DeepClone();
        foreach (var k in new[] { "slot", "fx", "song", "lock", "session", "arr", "userKits", "userPresets", "mode", "devs", "buses" })
            if (json[k] != null) parts[k] = json[k]!.DeepClone();
        var eng = new AudioEngine(rate, 1024);
        eng.Seq.P.Apply(parts);
        eng.Seq.Sync();
        eng.Seq.Start();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var (l, r) = eng.RenderOffline(seconds);
        double s = 0, pk = 0;
        for (int i = 0; i < l.Length; i++) { s += l[i] * l[i] + r[i] * r[i]; pk = Math.Max(pk, Math.Max(Math.Abs(l[i]), Math.Abs(r[i]))); }
        Console.WriteLine($"{seconds} s renderizzati in {sw.Elapsed.TotalSeconds:0.00} s ({seconds / sw.Elapsed.TotalSeconds:0}× tempo reale), voci attive: {eng.Mx.LiveVoices}");
        Console.WriteLine($"rms {Math.Sqrt(s / (2 * l.Length)):0.0000} peak {pk:0.0000}");
        double Win(double a, double z)
        {
            double ss = 0; int n = 0;
            for (int i = (int)(a * rate); i < Math.Min(l.Length, (int)(z * rate)); i++) { ss += l[i] * l[i] + r[i] * r[i]; n += 2; }
            return n > 0 ? Math.Sqrt(ss / n) : 0;
        }
        Console.WriteLine($"early {Win(0.02, 0.3):0.000000} tail {Win(0.4, 2.0):0.000000}");
        Profiler.Report();
        Wav.Write(wavPath, l, r, rate);
    }
}

public static class Wav
{
    public static void Write(string path, float[] l, float[] r, int rate)
    {
        using var w = new BinaryWriter(File.Create(path));
        int n = l.Length, bytes = n * 4;
        w.Write("RIFF"u8); w.Write(36 + bytes); w.Write("WAVE"u8);
        w.Write("fmt "u8); w.Write(16); w.Write((short)1); w.Write((short)2); w.Write(rate); w.Write(rate * 4); w.Write((short)4); w.Write((short)16);
        w.Write("data"u8); w.Write(bytes);
        for (int i = 0; i < n; i++)
        {
            w.Write((short)Math.Round(Math.Clamp(l[i], -1, 1) * 32767));
            w.Write((short)Math.Round(Math.Clamp(r[i], -1, 1) * 32767));
        }
    }
}
