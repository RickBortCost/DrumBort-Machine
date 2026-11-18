// Model.cs — Modello del progetto (stesso formato JSON della web app) e preset synth.

using System.Text.Json.Nodes;

namespace DrumBort.Engine;

static class J
{
    public static double D(JsonNode? n, string k, double def)
    {
        var v = n?[k];
        if (v is JsonValue jv && jv.TryGetValue(out double d) && double.IsFinite(d)) return d;
        return def;
    }
    public static int I(JsonNode? n, string k, int def) => (int)Math.Round(D(n, k, def));
    public static bool B(JsonNode? n, string k) { var v = n?[k]; return v is JsonValue jv && (jv.TryGetValue(out bool b) ? b : jv.TryGetValue(out double d) && d != 0); }
    public static string S(JsonNode? n, string k, string def) { var v = n?[k]; return v is JsonValue jv && jv.TryGetValue(out string? s) && s != null ? s : def; }
    public static double? Opt(JsonNode? n, string k) { var v = n?[k]; return v is JsonValue jv && jv.TryGetValue(out double d) && double.IsFinite(d) ? d : null; }
    public static double[] Nums(JsonNode? n) => n is JsonArray a ? a.Select(x => x is JsonValue v && v.TryGetValue(out double d) ? d : 0).ToArray() : Array.Empty<double>();
}

public sealed class StepOpt
{
    public int P = 100, R = 1, N; public bool F;
    public double? Tune, Decay, Vel;
    public static StepOpt? Parse(JsonNode? n)
    {
        if (n is not JsonObject) return null;
        var pl = n["pl"];
        return new StepOpt
        {
            P = J.I(n, "p", 100), R = Math.Clamp(J.I(n, "r", 1), 1, 4), F = J.B(n, "f"), N = J.I(n, "n", 0),
            Tune = J.Opt(pl, "tune"), Decay = J.Opt(pl, "decay"), Vel = J.Opt(pl, "vel"),
        };
    }
}

public sealed class DrumTrack
{
    public double Vol = 0.8, Tune, Decay = 1, Pan, Rev, Dly, Drv, Flt, Lo, Hi, Cmp; public int Len = 16, Crush; public bool Mute, Solo;
    public MixParams Mix => new(Vol, Pan, Rev, Dly, Drv, Crush, Flt, Lo, Hi, Cmp);
    public static DrumTrack Parse(JsonNode? n, int steps = 16) => new()
    {
        Vol = J.D(n, "vol", 0.8), Tune = J.D(n, "tune", 0), Decay = J.D(n, "decay", 1), Pan = J.D(n, "pan", 0),
        Rev = J.D(n, "rev", 0), Dly = J.D(n, "dly", 0), Drv = J.D(n, "drv", 0), Crush = J.I(n, "crush", 0),
        Flt = J.D(n, "flt", 0), Lo = J.D(n, "lo", 0), Hi = J.D(n, "hi", 0), Cmp = J.D(n, "cmp", 0),
        Len = Math.Clamp(J.I(n, "len", steps), 1, steps), Mute = J.B(n, "mute"), Solo = J.B(n, "solo"),
    };
    public DrumTrack With(StepOpt? o) => o == null || (o.Tune == null && o.Decay == null) ? this
        : new DrumTrack { Vol = Vol, Tune = o.Tune ?? Tune, Decay = o.Decay ?? Decay, Pan = Pan, Rev = Rev, Dly = Dly, Drv = Drv, Crush = Crush, Len = Len, Flt = Flt, Lo = Lo, Hi = Hi, Cmp = Cmp };
}

public sealed class SynthStep
{
    public int N, G = 1; public bool A, Sl; public int[]? Ch;
    public double? Cut, Dec, Vel;
    public static SynthStep? Parse(JsonNode? n)
    {
        if (n is not JsonObject || J.Opt(n, "n") == null) return null;
        var pl = n["pl"];
        var ch = n["ch"] is JsonArray a && a.Count > 0 ? J.Nums(a).Select(x => (int)x).ToArray() : null;
        return new SynthStep { N = J.I(n, "n", 60), G = Math.Max(1, J.I(n, "g", 1)), A = J.B(n, "a"), Sl = J.B(n, "sl"), Ch = ch,
            Cut = J.Opt(pl, "cut"), Dec = J.Opt(pl, "dec"), Vel = J.Opt(pl, "vel") };
    }
}

public sealed class Arp
{
    public bool On; public string Mode = "up"; public double Rate = 1, Gate = 0.6; public int Oct = 1, Src = 2;
    public static Arp Parse(JsonNode? n) => new()
    {
        On = J.B(n, "on"), Mode = J.S(n, "mode", "up"), Rate = J.D(n, "rate", 1), Gate = J.D(n, "gate", 0.6),
        Oct = Math.Clamp(J.I(n, "oct", 1), 1, 3), Src = Math.Clamp(J.I(n, "src", 2), 0, 3),
    };
}

public sealed class SynthTrack
{
    public string Preset = "acid303"; public Preset? Patch;
    public int Oct, Len = 16, Crush;
    public double Vol = 0.7, Pan, Rev, Dly, Cut, Res, Env = 1, Dec = 1, Atk = 1, Rel = 1, Lfo = 1, Rate = 1, Pos, Drv, Flt, Lo, Hi, Cmp;
    public MixParams Mix => new(Vol, Pan, Rev, Dly, Drv, Crush, Flt, Lo, Hi, Cmp);
    public bool Mute, Solo;
    public Arp Arp = new();
    public SynthStep?[] Steps = new SynthStep?[16];

    public static SynthTrack Parse(JsonNode? n, int k, int steps = 16)
    {
        var t = new SynthTrack
        {
            Steps = new SynthStep?[steps],
            Preset = J.S(n, "preset", SynthDefs.Tracks[k].Preset), Oct = J.I(n, "oct", 0),
            Vol = J.D(n, "vol", 0.7), Pan = J.D(n, "pan", 0), Rev = J.D(n, "rev", 0), Dly = J.D(n, "dly", 0),
            Cut = J.D(n, "cut", 0), Res = J.D(n, "res", 0), Env = J.D(n, "env", 1), Dec = J.D(n, "dec", 1),
            Atk = J.D(n, "atk", 1), Rel = J.D(n, "rel", 1), Lfo = J.D(n, "lfo", 1), Rate = J.D(n, "rate", 1), Pos = J.D(n, "pos", 0),
            Drv = J.D(n, "drv", 0), Crush = J.I(n, "crush", 0), Mute = J.B(n, "mute"), Solo = J.B(n, "solo"),
            Flt = J.D(n, "flt", 0), Lo = J.D(n, "lo", 0), Hi = J.D(n, "hi", 0), Cmp = J.D(n, "cmp", 0),
            Len = Math.Clamp(J.I(n, "len", steps), 1, steps), Arp = Arp.Parse(n?["arp"]),
        };
        if (n?["patch"] is JsonObject p && p["wt"] != null) t.Patch = Engine.Preset.Parse("patch", p);
        if (n?["steps"] is JsonArray st) for (int s = 0; s < steps && s < st.Count; s++) t.Steps[s] = SynthStep.Parse(st[s]);
        return t;
    }

    /// <summary>Traccia con i parameter lock dello step (cutoff, decay).</summary>
    public SynthTrack With(SynthStep st)
    {
        if (st.Cut == null && st.Dec == null) return this;
        var c = (SynthTrack)MemberwiseClone();
        if (st.Cut != null) c.Cut = st.Cut.Value;
        if (st.Dec != null) c.Dec = st.Dec.Value;
        return c;
    }
    public VoiceParams Params(double bpm) => new(Cut, Res, Env, Dec, Atk, Rel, Lfo, Rate, Pos, bpm);
}

/// <summary>Mixer e insert di un canale.</summary>
public readonly record struct MixParams(double Vol, double Pan, double Rev, double Dly, double Drv, int Crush, double Flt, double Lo, double Hi, double Cmp);

public readonly record struct VoiceParams(double Cut, double Res, double Env, double Dec, double Atk, double Rel, double Lfo, double Rate, double Pos, double Bpm);

public sealed class SynthSection
{
    public int Key = 9; public string Scale = "minor";
    public SynthTrack[] Tracks = new SynthTrack[4];
    public static SynthSection Parse(JsonNode? n, int steps = 16)
    {
        var s = new SynthSection { Key = J.I(n, "key", 9), Scale = J.S(n, "scale", "minor") };
        var tr = n?["tracks"] as JsonArray;
        for (int k = 0; k < 4; k++) s.Tracks[k] = SynthTrack.Parse(tr != null && k < tr.Count ? tr[k] : null, k, steps);
        return s;
    }
}

public sealed class Pattern
{
    public string Kit = "tr808"; public int Bpm = 120, Swing = 50, Bars = 1; public double Human;
    public int[][] Steps = Enumerable.Range(0, 8).Select(_ => new int[16]).ToArray();
    public StepOpt?[][] Opts = Enumerable.Range(0, 8).Select(_ => new StepOpt?[16]).ToArray();
    public DrumTrack[] Tracks = Enumerable.Range(0, 8).Select(_ => new DrumTrack()).ToArray();
    public SynthSection Synth = SynthSection.Parse(null);
    /// <summary>Session: kit di ogni traccia (null = kit del pattern).</summary>
    public KitDef?[]? Kits;
    /// <summary>Automazione: bersaglio ("d0.vol", "s1.cut", "fx.filter") → valore 0..1 per step (null = valore della traccia).</summary>
    public Dictionary<string, double?[]>? Auto;

    public static Pattern Parse(JsonNode? n)
    {
        int bars = J.I(n, "bars", 1) is var b && (b == 2 || b == 4) ? b : 1, N = 16 * bars;
        var p = new Pattern { Kit = J.S(n, "kit", "tr808"), Bpm = Math.Clamp(J.I(n, "bpm", 120), 40, 240), Swing = Math.Clamp(J.I(n, "swing", 50), 50, 75), Human = J.D(n, "human", 0), Bars = bars };
        p.Steps = Enumerable.Range(0, 8).Select(_ => new int[N]).ToArray();
        p.Opts = Enumerable.Range(0, 8).Select(_ => new StepOpt?[N]).ToArray();
        var st = n?["steps"] as JsonArray; var op = n?["opts"] as JsonArray; var tr = n?["tracks"] as JsonArray;
        for (int t = 0; t < 8; t++)
        {
            var row = st != null && t < st.Count ? st[t] as JsonArray : null;
            var orow = op != null && t < op.Count ? op[t] as JsonArray : null;
            for (int s = 0; s < N; s++)
            {
                if (row != null && s < row.Count && row[s] is JsonValue v && v.TryGetValue(out double d)) p.Steps[t][s] = d >= 2 ? 2 : d > 0 ? 1 : 0;
                if (orow != null && s < orow.Count) p.Opts[t][s] = StepOpt.Parse(orow[s]);
            }
            p.Tracks[t] = DrumTrack.Parse(tr != null && t < tr.Count ? tr[t] : null, N);
        }
        p.Synth = SynthSection.Parse(n?["synth"], N);
        if (n?["auto"] is JsonObject au)
        {
            p.Auto = new();
            foreach (var (k, v) in au)
                if (v is JsonArray a)
                    p.Auto[k] = Enumerable.Range(0, N).Select(i => i < a.Count && a[i] is JsonValue jv && jv.TryGetValue(out double d) ? (double?)Math.Clamp(d, 0, 1) : null).ToArray();
        }
        return p;
    }

    public Pattern Clone() => (Pattern)MemberwiseClone();
}

// =====================================================================
// Preset synth (presets.json e patch wavetable)
// =====================================================================

public sealed record OscDef(string Type, double Oct, double Det, double G);
public sealed record GenDef(string Type, double Damp, double Bright, double Len, double B, double Beat);
public sealed record FmDef(double Ratio, double Index, double Decay);
public sealed record NoiseDef(double G, double Hp, double D);
public sealed record LfoDef(string To, double Rate, double Depth, double Delay);
public sealed record PitchDef(double From, double To, double Time);

public sealed class Preset
{
    public string Id = "", Name = "";
    public OscDef[] Osc = Array.Empty<OscDef>();
    public GenDef? Gen; public FmDef? Fm; public NoiseDef? Noise; public LfoDef? Lfo; public PitchDef? Pitch;
    public double[][]? Formants;
    public double Cut = 2000, Res = 1, EnvOct, Fdec = 0.2, A = 0.005, D = 0.5, S = 0.8, R = 0.3, Glide, Drive, Gain = 1;
    public WtPatch? Wt;
    public int Rev;
    /// <summary>Impronta del contenuto (chiave della cache per le patch modificate).</summary>
    public uint Hash;

    public static Preset Parse(string id, JsonNode n)
    {
        var p = new Preset
        {
            Id = id, Name = J.S(n, "name", id),
            Cut = J.D(n, "cut", 2000), Res = J.D(n, "res", 1), EnvOct = J.D(n, "envOct", 0), Fdec = J.D(n, "fdec", 0.2),
            A = J.D(n, "a", 0.005), D = J.D(n, "d", 0.5), S = J.D(n, "s", 0.8), R = J.D(n, "r", 0.3),
            Glide = J.D(n, "glide", 0), Drive = J.D(n, "drive", 0), Gain = J.D(n, "gain", 1), Rev = J.I(n, "rev", 0),
            Hash = (uint)n.ToJsonString().GetHashCode(),
        };
        if (n["osc"] is JsonArray oa) p.Osc = oa.Select(o => new OscDef(J.S(o, "type", "sine"), J.D(o, "oct", 0), J.D(o, "det", 0), J.D(o, "g", 1))).ToArray();
        if (n["gen"] is JsonObject g) p.Gen = new GenDef(J.S(g, "type", "pluck"), J.D(g, "damp", 0.995), J.D(g, "bright", 0.5), J.D(g, "len", 1.5), J.D(g, "B", 0.0005), J.D(g, "beat", 0.001));
        if (n["fm"] is JsonObject f) p.Fm = new FmDef(J.D(f, "ratio", 1), J.D(f, "index", 1), J.D(f, "decay", 0.3));
        if (n["noise"] is JsonObject no) p.Noise = new NoiseDef(J.D(no, "g", 0.1), J.D(no, "hp", 20), J.D(no, "d", 0));
        if (n["lfo"] is JsonObject l) p.Lfo = new LfoDef(J.S(l, "to", "pitch"), J.D(l, "rate", 5), J.D(l, "depth", 0), J.D(l, "delay", 0));
        if (n["pitch"] is JsonObject pi) p.Pitch = new PitchDef(J.D(pi, "from", 0), J.D(pi, "to", 0), J.D(pi, "time", 0.1));
        if (n["formants"] is JsonArray fa) p.Formants = fa.Select(J.Nums).ToArray();
        if (n["wt"] is JsonObject w) p.Wt = WtPatch.Parse(w);
        return p;
    }
}

public sealed record WtOsc(string Table, double Pos, double Semi, double Fine, double Level);
public sealed record WtFilter(string Type, double Cut, double Res);
public sealed record WtEnv(double A, double D, double S, double R);
public sealed record WtLfo(string Shape, double Rate, double Sync);
public sealed record WtMod(string Src, string Dst, double Amt);

public sealed class WtPatch
{
    public WtOsc[] Osc = Array.Empty<WtOsc>();
    public int UniVoices = 1; public double UniDetune = 12, Noise, Mix = 0.5, Drive;
    public WtFilter F1 = new("lowpass", 3000, 1), F2 = new("none", 1200, 1);
    public string Route = "serial";
    public WtEnv Env2 = new(0.01, 0.4, 0, 0.3);
    public WtLfo Lfo1 = new("sine", 2, 0), Lfo2 = new("triangle", 0.3, 0);
    public double[] StepValues = new double[16]; public double StepDiv = 1;
    public WtMod[] Mod = Array.Empty<WtMod>();

    public static WtPatch Parse(JsonNode w)
    {
        WtFilter F(JsonNode? f, string t) => new(J.S(f, "type", t), J.D(f, "cut", 1000), J.D(f, "res", 1));
        WtLfo L(JsonNode? l, string s) => new(J.S(l, "shape", s), J.D(l, "rate", 1), J.D(l, "sync", 0));
        var p = new WtPatch
        {
            UniVoices = Math.Clamp(J.I(w["uni"], "voices", 1), 1, 3), UniDetune = J.D(w["uni"], "detune", 12),
            Noise = J.D(w, "noise", 0), Mix = J.D(w, "mix", 0.5), Drive = J.D(w, "drive", 0), Route = J.S(w, "route", "serial"),
            F1 = F(w["f1"], "lowpass"), F2 = F(w["f2"], "none"),
            Env2 = new WtEnv(J.D(w["env2"], "a", 0.01), J.D(w["env2"], "d", 0.4), J.D(w["env2"], "s", 0), J.D(w["env2"], "r", 0.3)),
            Lfo1 = L(w["lfo1"], "sine"), Lfo2 = L(w["lfo2"], "triangle"),
            StepValues = J.Nums(w["step"]?["values"]).Concat(new double[16]).Take(16).ToArray(), StepDiv = J.D(w["step"], "div", 1),
        };
        if (w["osc"] is JsonArray oa) p.Osc = oa.Select(o => new WtOsc(J.S(o, "table", "analog"), J.D(o, "pos", 0), J.D(o, "semi", 0), J.D(o, "fine", 0), J.D(o, "level", 0))).ToArray();
        if (w["mod"] is JsonArray ma) p.Mod = ma.Select(m => new WtMod(J.S(m, "src", ""), J.S(m, "dst", ""), J.D(m, "amt", 0))).ToArray();
        return p;
    }
}

/// <summary>Tracce synth: BASS e LEAD monofoniche, PAD e KEYS accordi.</summary>
public static class SynthDefs
{
    public sealed record Def(string Name, string Short, int Oct, string Preset, bool Mono);
    public static readonly Def[] Tracks =
    {
        new("Bass", "BS", 2, "acid303", true), new("Lead", "LD", 4, "sh101lead", true),
        new("Pad", "PD", 3, "juno", false), new("Keys", "KY", 4, "epiano", false),
    };
}
