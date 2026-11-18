// Devices.cs — Catena di device per traccia (porting di js/devices.js): stessi tipi, stessi
// parametri e stessa struttura dei nodi. Ogni device: ingresso → elaborazione → uscita, con
// Dry/Wet dove previsto.

using System.Text.Json.Nodes;
using DrumBort.Audio;

namespace DrumBort.Engine;

/// <summary>Device della catena di una traccia, come arriva dalla web app.</summary>
public sealed class DeviceDef
{
    public string Id = "", Type = ""; public bool On = true;
    public Dictionary<string, double> N = new(); public Dictionary<string, string> S = new();
    public double P(string k, double def) => N.TryGetValue(k, out var v) ? v : def;
    public string E(string k, string def) => S.TryGetValue(k, out var v) ? v : def;

    public static DeviceDef[] ParseChain(JsonNode? n)
    {
        if (n is not JsonArray a) return Array.Empty<DeviceDef>();
        var list = new List<DeviceDef>();
        foreach (var x in a)
        {
            if (x is not JsonObject o) continue;
            var d = new DeviceDef { Id = J.S(o, "id", ""), Type = J.S(o, "type", ""), On = o["on"] is not JsonValue ov || !ov.TryGetValue(out bool b) || b };
            if (o["p"] is JsonObject p)
                foreach (var (k, v) in p)
                    if (v is JsonValue jv)
                    {
                        if (J.TryD(jv, out double num)) d.N[k] = num;
                        else if (jv.TryGetValue(out string? s) && s != null) d.S[k] = s;
                    }
            list.Add(d);
        }
        return list.ToArray();
    }
}

/// <summary>Nodi di un device costruito.</summary>
public sealed class DeviceInst
{
    public required string Type;
    public required GainNode Input, Output;
    public required Action<DeviceDef, double, double> Set;   // (parametri, tempo, bpm)
    public List<AudioNode> Nodes = new();
    public List<SourceNode> Sources = new();
    public void Stop()
    {
        foreach (var s in Sources) s.Stop(0);
        Input.Disconnect(); Output.Disconnect();
        foreach (var n in Nodes) n.Disconnect();
    }
}

public static class Devices
{
    static float Db2A(double d) => (float)Math.Pow(10, d / 20);
    static readonly double[] Divs = { 0.5, 1, 1.5, 2, 3, 4, 6, 8, 16 };
    public static double DelaySec(string div, double bpm)
    {
        int i = int.TryParse(div, out var v) ? Math.Clamp(v, 0, Divs.Length - 1) : 5;
        return Math.Min(4, 60 / bpm / 4 * Divs[i]);
    }
    static double FilterQ(string type, double res) => type is "lowpass" or "highpass" ? res * 24 : 0.5 + res * 15;

    static readonly Dictionary<string, float[]> curves = new();
    /// <summary>Curve del Saturator (come satCurve in js/devices.js).</summary>
    public static float[] SatCurve(string type, double drive)
    {
        string key = $"{type}|{Math.Round(drive * 10)}";
        lock (curves)
        {
            if (curves.TryGetValue(key, out var c)) return c;
            int n = 4096; c = new float[n]; double g = Math.Pow(10, drive / 20), t25 = Math.Tanh(0.25);
            for (int i = 0; i < n; i++)
            {
                double x = (double)i / (n - 1) * 2 - 1, u = x * g, y;
                if (type == "hard") y = Math.Clamp(u, -1, 1);
                else if (type == "tube") y = (Math.Tanh(u + 0.25) - t25) / (1 - t25) * 0.7;
                else if (type == "fold") y = Math.Sin(u * Math.PI / 2);
                else y = Math.Tanh(u);
                c[i] = (float)y;
            }
            if (curves.Count > 200) curves.Clear();
            curves[key] = c;
            return c;
        }
    }
    static readonly Dictionary<int, float[]> bits = new();
    public static float[] BitCurve(double b)
    {
        int k = (int)Math.Round(b);
        lock (bits)
        {
            if (bits.TryGetValue(k, out var c)) return c;
            int n = 65536; c = new float[n]; double steps = Math.Pow(2, k - 1);
            for (int i = 0; i < n; i++) { double x = (double)i / (n - 1) * 2 - 1; c[i] = (float)(Math.Round(x * steps) / steps); }
            bits[k] = c;
            return c;
        }
    }

    /// <summary>Catena equivalente agli effetti per traccia delle versioni precedenti (come legacyChain).</summary>
    public static DeviceDef[] Legacy(MixParams m)
    {
        var o = new List<DeviceDef>();
        DeviceDef D(string type, params (string k, double v)[] p)
        {
            var d = new DeviceDef { Id = $"l{o.Count}{type}", Type = type };
            foreach (var (k, v) in p) d.N[k] = v;
            o.Add(d);
            return d;
        }
        if (m.Drv > 0) D("sat", ("drive", 20 * Math.Log10(1 + m.Drv * 12)), ("out", 20 * Math.Log10(1 / (1 + m.Drv * 1.5))), ("mix", 1)).S["type"] = "soft";
        if (m.Crush > 0) D("redux", ("bits", m.Crush), ("tone", 20000), ("mix", 1));
        if (m.Lo != 0 || m.Hi != 0) D("eq", ("lg", m.Lo), ("hg", m.Hi));
        if (Math.Abs(m.Flt) > 0.02)
        {
            var (lp, hp) = Mixer.FilterFreqs(m.Flt);
            D("filter", ("f", m.Flt < 0 ? lp : hp), ("res", 0.04), ("mix", 1)).S["type"] = m.Flt < 0 ? "lowpass" : "highpass";
        }
        if (m.Cmp > 0) D("comp", ("thr", Math.Round(-6 - 30 * m.Cmp)), ("ratio", 1.5 + 8.5 * m.Cmp), ("atk", 5), ("rel", 150), ("knee", 6), ("gain", 0), ("mix", 1));
        return o.ToArray();
    }

    /// <summary>Crea i nodi del device.</summary>
    public static DeviceInst Build(AudioContext ctx, DeviceDef dev)
    {
        var scope = ctx.Scope;
        ctx.Scope = null;           // gli LFO non appartengono a una voce
        try { return BuildInner(ctx, dev); }
        finally { ctx.Scope = scope; }
    }

    static DeviceInst BuildInner(AudioContext ctx, DeviceDef dev)
    {
        var input = ctx.Gain(); var output = ctx.Gain();
        var nodes = new List<AudioNode>(); var srcs = new List<SourceNode>();
        T Mk<T>(T n) where T : AudioNode { nodes.Add(n); return n; }
        GainNode? dry = null, wet = null;
        void WetPath(AudioNode first, AudioNode last)
        {
            dry = Mk(ctx.Gain()); wet = Mk(ctx.Gain());
            input.Connect(dry).Connect(output);
            input.Connect(first); last.Connect(wet).Connect(output);
        }
        void Mix(double m, double t) { dry?.GainParam.SetTargetAtTime((float)(1 - m), t, 0.02); wet?.GainParam.SetTargetAtTime((float)m, t, 0.02); }
        const double tc = 0.02;
        Action<DeviceDef, double, double> set;

        switch (dev.Type)
        {
            case "eq":
            {
                var lo = Mk(ctx.Biquad("lowshelf")); var mid = Mk(ctx.Biquad("peaking")); var hi = Mk(ctx.Biquad("highshelf"));
                input.Connect(lo).Connect(mid).Connect(hi).Connect(output);
                set = (d, t, _) =>
                {
                    lo.Frequency.SetTargetAtTime((float)d.P("lf", 200), t, tc); lo.GainParam.SetTargetAtTime((float)d.P("lg", 0), t, tc);
                    mid.Frequency.SetTargetAtTime((float)d.P("mf", 1000), t, tc); mid.GainParam.SetTargetAtTime((float)d.P("mg", 0), t, tc); mid.Q.SetTargetAtTime((float)d.P("mq", 1), t, tc);
                    hi.Frequency.SetTargetAtTime((float)d.P("hf", 5000), t, tc); hi.GainParam.SetTargetAtTime((float)d.P("hg", 0), t, tc);
                };
                break;
            }
            case "filter":
            {
                var f = Mk(ctx.Biquad("lowpass")); var lfo = Mk(ctx.Oscillator("sine")); var amt = Mk(ctx.Gain(0));
                lfo.Connect(amt); amt.Connect(f.Detune);
                lfo.Start(0); srcs.Add(lfo);
                WetPath(f, f);
                set = (d, t, _) =>
                {
                    string type = d.E("type", "lowpass");
                    f.Type = type is "lowpass" or "highpass" or "bandpass" or "notch" ? type : "lowpass";
                    f.Frequency.SetTargetAtTime((float)d.P("f", 2000), t, tc);
                    f.Q.SetTargetAtTime((float)FilterQ(f.Type, d.P("res", 0.2)), t, tc);
                    lfo.Frequency.SetTargetAtTime((float)d.P("rate", 1), t, tc);
                    amt.GainParam.SetTargetAtTime((float)(d.P("lfo", 0) * 2400), t, tc);
                    Mix(d.P("mix", 1), t);
                };
                break;
            }
            case "comp":
            {
                var c = Mk(new CompressorNode(ctx)); var g = Mk(ctx.Gain());
                c.Connect(g);
                WetPath(c, g);
                set = (d, t, _) =>
                {
                    c.Configure((float)d.P("thr", -18), (float)d.P("ratio", 4), (float)d.P("knee", 6), (float)(d.P("atk", 5) / 1000), (float)(d.P("rel", 150) / 1000));
                    g.GainParam.SetTargetAtTime(Db2A(d.P("gain", 0)), t, tc);
                    Mix(d.P("mix", 1), t);
                };
                break;
            }
            case "limiter":
            {
                var pre = Mk(ctx.Gain()); var c = Mk(new CompressorNode(ctx));
                input.Connect(pre).Connect(c).Connect(output);
                set = (d, t, _) =>
                {
                    pre.GainParam.SetTargetAtTime(Db2A(d.P("gain", 0)), t, tc);
                    c.Configure((float)d.P("ceil", -0.3), 20, 0, 0.001f, (float)(d.P("rel", 100) / 1000));
                };
                break;
            }
            case "sat":
            {
                var ws = Mk(ctx.Shaper(SatCurve("soft", 6), 4)); var g = Mk(ctx.Gain());
                ws.Connect(g);
                WetPath(ws, g);
                set = (d, t, _) =>
                {
                    ws.Curve = SatCurve(d.E("type", "soft"), d.P("drive", 6));
                    g.GainParam.SetTargetAtTime(Db2A(d.P("out", 0)), t, tc);
                    Mix(d.P("mix", 1), t);
                };
                break;
            }
            case "redux":
            {
                var ws = Mk(ctx.Shaper(BitCurve(8))); var f = Mk(ctx.Biquad("lowpass"));
                f.Q.Value = 0;
                ws.Connect(f);
                WetPath(ws, f);
                set = (d, t, _) =>
                {
                    ws.Curve = BitCurve(d.P("bits", 8));
                    f.Frequency.SetTargetAtTime((float)d.P("tone", 20000), t, tc);
                    Mix(d.P("mix", 1), t);
                };
                break;
            }
            case "delay":
            {
                var dl = Mk(ctx.Delay(4)); var fb = Mk(ctx.Gain(0)); var tone = Mk(ctx.Biquad("lowpass"));
                dl.Connect(tone).Connect(fb).Connect(dl);
                WetPath(dl, tone);
                set = (d, t, bpm) =>
                {
                    dl.DelayTime.SetTargetAtTime((float)DelaySec(d.E("div", "4"), bpm), t, 0.05);
                    fb.GainParam.SetTargetAtTime((float)d.P("fb", 0.4), t, tc);
                    tone.Frequency.SetTargetAtTime((float)d.P("tone", 5000), t, tc);
                    Mix(d.P("mix", 0.3), t);
                };
                break;
            }
            case "reverb":
            {
                var pre = Mk(ctx.Delay(0.2)); var rv = Mk(new ReverbNode(ctx)); var tone = Mk(ctx.Biquad("lowpass"));
                tone.Q.Value = 0;
                pre.Connect(rv).Connect(tone);
                WetPath(pre, tone);
                double size = 2.2;
                set = (d, t, _) =>
                {
                    double s = d.P("size", 2);
                    if (Math.Abs(s - size) > 0.05) { size = s; rv.SetSize(s); }
                    pre.DelayTime.SetTargetAtTime((float)(d.P("pre", 10) / 1000), t, tc);
                    tone.Frequency.SetTargetAtTime((float)d.P("tone", 9000), t, tc);
                    Mix(d.P("mix", 0.3), t);
                };
                break;
            }
            case "chorus":
            {
                var ch = Mk(new ChorusNode(ctx));
                WetPath(ch, ch);
                set = (d, t, _) => { ch.Rate = d.P("rate", 0.8); ch.Depth = d.P("depth", 0.5); ch.BaseMs = d.P("dly", 12); Mix(d.P("mix", 0.5), t); };
                break;
            }
            case "utility":
            {
                var u = Mk(new UtilityNode(ctx));
                input.Connect(u).Connect(output);
                set = (d, t, _) => { u.Gain = Db2A(d.P("gain", 0)) * (d.E("phase", "0") == "1" ? -1 : 1); u.Width = (float)d.P("width", 1); };
                break;
            }
            default:
                input.Connect(output);
                set = (_, _, _) => { };
                break;
        }
        return new DeviceInst { Type = dev.Type, Input = input, Output = output, Set = set, Nodes = nodes, Sources = srcs };
    }
}

/// <summary>Chorus stereo: due ritardi modulati dallo stesso LFO sinusoidale in controfase.</summary>
public sealed class ChorusNode : AudioNode
{
    public double Rate = 0.8, Depth = 0.5, BaseMs = 12;
    readonly float[] bl, br; int w; double ph;
    readonly float[] inL = new float[AudioContext.Block], inR = new float[AudioContext.Block];
    public ChorusNode(AudioContext c) : base(c) { int n = (int)(0.1 * c.SampleRate); bl = new float[n]; br = new float[n]; }
    protected override void Process()
    {
        SumInputs(inL, inR, out bool st);
        if (!st) Array.Copy(inL, inR, AudioContext.Block);
        double sr = Ctx.SampleRate, baseS = BaseMs / 1000, dep = Depth * Math.Min(baseS * 0.8, 0.006);
        int n = bl.Length;
        for (int i = 0; i < AudioContext.Block; i++)
        {
            bl[w] = inL[i]; br[w] = inR[i];
            double lfo = Math.Sin(ph);
            ph += 2 * Math.PI * Rate / sr; if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
            L[i] = Tap(bl, (baseS + dep * lfo) * sr, n);
            R[i] = Tap(br, (baseS - dep * lfo) * sr, n);
            if (++w >= n) w = 0;
        }
        Stereo = true;
    }
    float Tap(float[] b, double d, int n)
    {
        double rp = w - d; while (rp < 0) rp += n;
        int a = (int)rp; int c = (a + 1) % n; float fr = (float)(rp - a);
        return b[a % n] + (b[c] - b[a % n]) * fr;
    }
}

/// <summary>Utility: guadagno (con inversione di fase) e ampiezza stereo (matrice L/R).</summary>
public sealed class UtilityNode : AudioNode
{
    public float Gain = 1, Width = 1;
    public UtilityNode(AudioContext c) : base(c) { }
    protected override void Process()
    {
        SumInputs(L, R, out bool st);
        if (!st) Array.Copy(L, R, AudioContext.Block);
        float a = (1 + Width) / 2, b = (1 - Width) / 2;
        for (int i = 0; i < AudioContext.Block; i++)
        {
            float l = L[i], r = R[i];
            L[i] = (a * l + b * r) * Gain;
            R[i] = (b * l + a * r) * Gain;
        }
        Stereo = true;
    }
}

/// <summary>Track Stack: tracce che passano per un bus comune (device, volume, mute).</summary>
public sealed class StackDef
{
    public string Name = "Stack";
    public int[] Tracks = Array.Empty<int>();
    public double Vol = 0.8;
    public bool Mute;
    public DeviceDef[] Devs = Array.Empty<DeviceDef>();
}

/// <summary>
/// Parte "buses" del progetto: { ret: [{devs}, {devs}], master: {devs}, stacks: [{name, tracks, vol, mute, devs}] }.
/// La web app la conserva senza usarla.
/// </summary>
public sealed class BusesDef
{
    public DeviceDef[][] Ret = { Array.Empty<DeviceDef>(), Array.Empty<DeviceDef>() };
    public DeviceDef[] Master = Array.Empty<DeviceDef>();
    public StackDef[] Stacks = Array.Empty<StackDef>();

    public static BusesDef Parse(System.Text.Json.Nodes.JsonNode? n)
    {
        var b = new BusesDef();
        if (n == null) return b;
        for (int i = 0; i < 2; i++) b.Ret[i] = DeviceDef.ParseChain(n["ret"]?[i]?["devs"]);
        b.Master = DeviceDef.ParseChain(n["master"]?["devs"]);
        if (n["stacks"] is System.Text.Json.Nodes.JsonArray st)
            b.Stacks = st.Take(Mixer.Stacks).Select(x => new StackDef
            {
                Name = J.S(x, "name", "Stack"),
                Tracks = J.Nums(x?["tracks"]).Select(v => (int)v).Where(v => v >= 0 && v < Mixer.Channels).ToArray(),
                Vol = Math.Clamp(J.D(x, "vol", 0.8), 0, 1),
                Mute = J.B(x, "mute"),
                Devs = DeviceDef.ParseChain(x?["devs"]),
            }).ToArray();
        return b;
    }
}
