// Wavetable.cs — Synth wavetable: porting di playWT (js/wavetable.js). Il morph dei 4 frame
// è fatto da un unico nodo (WtOscNode) invece di 4 oscillatori + waveshaper + gain per frame.

using DrumBort.Audio;

namespace DrumBort.Engine;

/// <summary>Oscillatore a 4 frame: la posizione (segnale −1…1) pesa i frame con finestre a triangolo.</summary>
public sealed class WtOscNode : SourceNode
{
    public readonly AudioParam Frequency, Detune, Position;
    readonly PeriodicWave[] frames;
    readonly float[][] tabsBuf;
    double phase;

    public WtOscNode(AudioContext c, PeriodicWave[] frames) : base(c)
    {
        this.frames = frames;
        tabsBuf = new float[frames.Length][];
        Frequency = new AudioParam(c, 440); Detune = new AudioParam(c, 0); Position = new AudioParam(c, -1);
    }

    protected override void Process()
    {
        Stereo = false;
        Array.Clear(L);
        if (!ActiveRange(out int from, out int to)) return;
        Frequency.Compute(); Detune.Compute(); Position.Compute();
        var fq = Frequency.Values; var dt = Detune.Values; var ps = Position.Values;
        float sr = Ctx.SampleRate, ny = Ctx.Nyquist;
        int F = frames.Length;
        var tabs = tabsBuf;
        float fRef = fq[from] * MathF.Pow(2, dt[from] / 1200f);
        for (int k = 0; k < F; k++) tabs[k] = frames[k].TableFor(Math.Abs(fRef), ny);
        bool cst = Frequency.Constant && Detune.Constant;
        for (int i = from; i < to; i++)
        {
            float f = cst ? fRef : fq[i] * MathF.Pow(2, dt[i] / 1200f);
            if (!cst && (i & 31) == 0) for (int k = 0; k < F; k++) tabs[k] = frames[k].TableFor(Math.Abs(f), ny);
            float x = Math.Clamp((ps[i] + 1) * 0.5f, 0, 1) * (F - 1);
            double p = phase * PeriodicWave.Size;
            int idx = (int)p; float fr = (float)(p - idx);
            float v = 0;
            int k0 = (int)x;
            for (int k = Math.Max(0, k0); k <= Math.Min(F - 1, k0 + 1); k++)
            {
                float w = 1 - Math.Abs(x - k);
                if (w <= 0) continue;
                var t = tabs[k];
                v += w * (t[idx] + (t[idx + 1] - t[idx]) * fr);
            }
            L[i] = v;
            phase += f / sr;
            phase -= Math.Floor(phase);
        }
    }
}

public static class Wavetable
{
    const int H = 64, F = 4;
    const float EPS = 0.0001f;

    static (float[] re, float[] im) Dft(Func<double, double> fn, int N = 512)
    {
        var xs = new double[N];
        for (int i = 0; i < N; i++) xs[i] = fn((double)i / N);
        var re = new float[H]; var im = new float[H];
        for (int n = 1; n < H; n++)
        {
            double a = 0, b = 0;
            for (int i = 0; i < N; i++) { double w = 2 * Math.PI * n * i / N; a += xs[i] * Math.Cos(w); b += xs[i] * Math.Sin(w); }
            re[n] = (float)(2 * a / N); im[n] = (float)(2 * b / N);
        }
        return (re, im);
    }

    static (float[] re, float[] im) Spectrum(Func<int, double> amp)
    {
        var re = new float[H]; var im = new float[H];
        for (int n = 1; n < H; n++) im[n] = (float)amp(n);
        return (re, im);
    }

    static double Gauss(double x, double m, double w) => Math.Exp(-((x - m) * (x - m)) / (2 * w * w));
    static readonly double[][] Vowels = { new double[] { 700, 1220 }, new double[] { 500, 1800 }, new double[] { 300, 2300 }, new double[] { 400, 800 } };

    static (float[], float[]) Gen(string table, int k)
    {
        switch (table)
        {
            case "sync": { double r = new[] { 1, 1.6, 2.4, 3.6 }[k]; return Dft(x => 2 * (x * r % 1) - 1); }
            case "formant": { var v = Vowels[k]; return Spectrum(n => (Gauss(n * 110, v[0], 120) + 0.6 * Gauss(n * 110, v[1], 180)) / Math.Sqrt(n)); }
            case "digital":
                return Spectrum(n =>
                {
                    if (k == 0) return n <= 4 ? 1.0 / n : 0;
                    if (k == 1) return new[] { 1, 2, 4, 8, 16, 32 }.Contains(n) ? 1 / Math.Sqrt(n) : 0;
                    if (k == 2) return new[] { 1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31 }.Contains(n) ? 1 / Math.Sqrt(n) : 0;
                    return n >= 6 && n <= 14 ? 0.5 : n == 1 ? 1 : 0;
                });
            case "harmonic": { int m = new[] { 1, 3, 7, 20 }[k]; return Spectrum(n => n <= m ? 1 / Math.Pow(n, 0.7) : 0); }
            case "growl": return Spectrum(n => (n % 2 == 1 ? 1.0 : -1.0) / n * Math.Abs(Math.Cos(Math.PI * n * (k + 1) / 9)));
            case "fm": { double I = new[] { 0.4, 1.4, 3, 5.5 }[k]; return Dft(x => Math.Sin(2 * Math.PI * x + I * Math.Sin(4 * Math.PI * x))); }
            default: // analog
                if (k == 0) return Spectrum(n => (n % 2 == 1 ? 1.0 : -1.0) / n);
                if (k == 1) return Spectrum(n => n % 2 == 1 ? 1.0 / n : 0);
                double d = k == 2 ? 0.25 : 0.1;
                return Dft(x => x < d ? 1 : -d / (1 - d));
        }
    }

    public static readonly string[] Tables = { "analog", "sync", "formant", "digital", "harmonic", "growl", "fm" };
    static readonly Dictionary<string, PeriodicWave[]> waves = new();
    static PeriodicWave[] Frames(string table)
    {
        lock (waves)
        {
            if (!Tables.Contains(table)) table = "analog";
            if (waves.TryGetValue(table, out var w)) return w;
            w = Enumerable.Range(0, F).Select(k => { var (re, im) = Gen(table, k); return new PeriodicWave(re, im); }).ToArray();
            waves[table] = w;
            return w;
        }
    }

    public static void Warm(float nyquist) { foreach (var t in Tables) foreach (var w in Frames(t)) w.Warm(nyquist); }

    static readonly Dictionary<int, float[]> drives = new();
    static float[] DriveCurve(double a)
    {
        int key = (int)Math.Round(a * 20);
        lock (drives)
        {
            if (!drives.TryGetValue(key, out var c))
            {
                int n = 1024; c = new float[n]; double k = 1 + a * 10;
                for (int i = 0; i < n; i++) { double x = (double)i / (n - 1) * 2 - 1; c[i] = (float)(Math.Tanh(x * k) / Math.Tanh(k)); }
                drives[key] = c;
            }
            return c;
        }
    }

    static AudioBuf StepBuffer(AudioContext ctx, double[] values)
    {
        const int seg = 64;
        var b = new AudioBuf(1, 16 * seg, ctx.SampleRate);
        for (int i = 0; i < 16; i++) Array.Fill(b.Data[0], (float)values[i], i * seg, seg);
        return b;
    }

    public static IVoiceHandle Play(AudioContext ctx, AudioNode outp, double t, double? dur, int[] notes, double vel, Preset pr, VoiceParams p, int? glideFrom)
    {
        var W = pr.Wt!;
        double bpm = p.Bpm > 0 ? p.Bpm : 120;
        bool accent = vel >= 0.95;
        double decMul = p.Dec;
        double a = pr.A * p.Atk, d = pr.D * decMul, s = pr.S, r = pr.R * Math.Sqrt(decMul) * p.Rel;
        double peak = (0.36 + vel * 0.3) / Math.Sqrt(notes.Length) * pr.Gain;
        var sources = new List<SourceNode>();
        double modDepth = p.Lfo;

        var rel = ctx.Gain();
        rel.Connect(outp);
        var trem = ctx.Gain();
        trem.Connect(rel);
        var amp = ctx.Gain();
        amp.GainParam.SetValueAtTime(EPS, t);
        if (a >= 0.05) amp.GainParam.LinearRampToValueAtTime((float)peak, t + a);
        else amp.GainParam.ExponentialRampToValueAtTime((float)peak, t + Math.Max(0.002, a));
        amp.GainParam.SetTargetAtTime((float)Math.Max(EPS, peak * s), t + a, Math.Max(0.01, d / 3));
        amp.Connect(trem);

        // Sorgenti di modulazione
        var one = ctx.Constant(1);
        sources.Add(one);
        var env2 = ctx.Gain();
        var e2 = W.Env2;
        double e2a = e2.A * p.Atk, e2d = e2.D * decMul;
        env2.GainParam.SetValueAtTime(0, t);
        env2.GainParam.LinearRampToValueAtTime(1, t + e2a);
        env2.GainParam.SetTargetAtTime((float)e2.S, t + e2a, Math.Max(0.01, e2d / 3));
        one.Connect(env2);
        var velSrc = ctx.Gain((float)vel);
        one.Connect(velSrc);
        var src = new Dictionary<string, AudioNode> { ["env2"] = env2, ["vel"] = velSrc };
        AudioNode Lfo(WtLfo cfg)
        {
            var o = ctx.Oscillator(cfg.Shape);
            o.Frequency.Value = (float)((cfg.Sync > 0 ? bpm / 60 / cfg.Sync : cfg.Rate) * p.Rate);
            sources.Add(o);
            return o;
        }
        var used = W.Mod.Select(m => m.Src).ToHashSet();
        if (used.Contains("lfo1")) src["lfo1"] = Lfo(W.Lfo1);
        if (used.Contains("lfo2")) src["lfo2"] = Lfo(W.Lfo2);
        if (used.Contains("step"))
        {
            var st = ctx.BufferSource(StepBuffer(ctx, W.StepValues));
            st.Loop = true;
            double loopSec = 16 * (60 / bpm / 4) * W.StepDiv;
            st.PlaybackRate.Value = (float)(st.Buffer.Duration / loopSec);
            sources.Add(st);
            src["step"] = st;
        }
        void Route(string sname, AudioParam param, double scale)
        {
            bool lfoLike = sname is "lfo1" or "lfo2" or "step";
            var g = ctx.Gain((float)(scale * (lfoLike ? modDepth : 1)));
            src[sname].Connect(g);
            g.Connect(param);
        }

        // Filtri e drive
        float accentCents = accent ? 700 : 0;
        BiquadFilterNode MkFilter(WtFilter cfg)
        {
            var f = ctx.Biquad(cfg.Type);
            f.Frequency.Value = (float)Math.Min(18000, cfg.Cut * Math.Pow(2, p.Cut * 3));
            f.Q.Value = (float)Math.Min(25, cfg.Res * Math.Pow(2, p.Res * 1.5));
            f.Detune.Value = accentCents;
            return f;
        }
        var f1 = MkFilter(W.F1);
        var f2 = W.F2.Type != "none" ? MkFilter(W.F2) : null;
        var pre = ctx.Gain();
        AudioNode entry = pre;
        if (W.Drive > 0)
        {
            var comp = ctx.Gain((float)(1 / (1 + W.Drive)));
            pre.Connect(ctx.Shaper(DriveCurve(W.Drive))).Connect(comp);
            entry = comp;
        }
        if (f2 == null) entry.Connect(f1).Connect(amp);
        else if (W.Route == "serial") entry.Connect(f1).Connect(f2).Connect(amp);
        else
        {
            entry.Connect(f1).Connect(ctx.Gain((float)(1 - W.Mix))).Connect(amp);
            entry.Connect(f2).Connect(ctx.Gain((float)W.Mix)).Connect(amp);
        }

        // Bus di posizione per oscillatore (−1…1)
        var posBus = W.Osc.Select(o =>
        {
            if (o.Level <= 0) return null;
            var bus = ctx.Gain();
            var off = ctx.Constant((float)(Math.Clamp(o.Pos + p.Pos, 0, 1) * 2 - 1));
            off.Connect(bus);
            sources.Add(off);
            return bus;
        }).ToArray();

        // Oscillatori
        var mix = ctx.Gain((float)(1 / (W.Osc.Sum(o => o.Level) is var al && al > 0 ? al : 1)));
        mix.Connect(pre);
        var pitchBus = ctx.Gain();
        var oscs = new List<SourceNode>();
        double glide = glideFrom != null && pr.Glide > 0 ? pr.Glide : 0;
        for (int i = 0; i < W.Osc.Length; i++)
        {
            var o = W.Osc[i];
            if (o.Level <= 0) continue;
            int voices = i == 0 ? W.UniVoices : 1;
            double[] spread = voices == 1 ? new[] { 0.0 } : voices == 2 ? new[] { -0.5, 0.5 } : new[] { -1.0, 0, 1 };
            var lvl = ctx.Gain((float)(o.Level / voices));
            lvl.Connect(mix);
            var frames = Frames(o.Table);
            foreach (var n in notes)
            {
                foreach (var sp in spread)
                {
                    var osc = new WtOscNode(ctx, frames);
                    double target = Synth.Mtof(n + o.Semi);
                    if (glide > 0)
                    {
                        osc.Frequency.SetValueAtTime((float)Synth.Mtof(glideFrom!.Value + (n - notes[0]) + o.Semi), t);
                        osc.Frequency.ExponentialRampToValueAtTime((float)target, t + glide);
                    }
                    else osc.Frequency.SetValueAtTime((float)target, t);
                    osc.Detune.Value = (float)(o.Fine + sp * W.UniDetune);
                    pitchBus.Connect(osc.Detune);
                    osc.Position.Value = 0;
                    posBus[i]!.Connect(osc.Position);
                    osc.Connect(lvl);
                    oscs.Add(osc);
                }
            }
        }
        if (W.Noise > 0)
        {
            var nz = ctx.BufferSource(Kits.Noise(ctx));
            nz.Loop = true;
            nz.Connect(ctx.Gain((float)(W.Noise * 0.6))).Connect(pre);
            sources.Add(nz);
        }

        // Matrice di modulazione
        double tremDepth = 0, envAmt = p.Env;
        foreach (var m in W.Mod)
        {
            if (!src.ContainsKey(m.Src) || m.Amt == 0) continue;
            double amt = m.Amt * (m.Src == "env2" ? envAmt : 1);
            switch (m.Dst)
            {
                case "pos":
                    foreach (var b in posBus) if (b != null) RouteNode(m.Src, b, 2 * amt);
                    break;
                case "pos1": case "pos2": case "pos3":
                {
                    var b = posBus[m.Dst[3] - '1'];
                    if (b != null) RouteNode(m.Src, b, 2 * amt);
                    break;
                }
                case "cut": Route(m.Src, f1.Detune, amt * 4800); if (f2 != null) Route(m.Src, f2.Detune, amt * 4800); break;
                case "cut1": Route(m.Src, f1.Detune, amt * 4800); break;
                case "cut2": if (f2 != null) Route(m.Src, f2.Detune, amt * 4800); break;
                case "pitch": RouteNode(m.Src, pitchBus, amt * 1200); break;
                case "res": Route(m.Src, f1.Q, amt * 10); break;
                case "amp":
                {
                    bool bip = m.Src is "lfo1" or "lfo2";
                    Route(m.Src, trem.GainParam, bip ? amt / 2 : Math.Abs(amt));
                    tremDepth += Math.Abs(amt) * (bip ? 0.5 : 1);
                    break;
                }
            }
        }
        trem.GainParam.Value = (float)(1 - Math.Min(0.95, tremDepth));

        // Collega una sorgente all'ingresso di un nodo-bus (somma di segnali)
        void RouteNode(string sname, AudioNode bus, double scale)
        {
            bool lfoLike = sname is "lfo1" or "lfo2" or "step";
            src[sname].Connect(ctx.Gain((float)(scale * (lfoLike ? modDepth : 1)))).Connect(bus);
        }

        foreach (var x in sources) x.Start(t);
        foreach (var x in oscs) x.Start(t);
        var all = sources.Concat(oscs).ToList();
        return Synth.MakeHandle(ctx, rel, all, r, t, dur, when => env2.GainParam.SetTargetAtTime(0, when, Math.Max(0.01, e2.R / 3)));
    }
}
