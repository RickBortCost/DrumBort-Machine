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

    static bool Same(float[] v, int from, int to)
    {
        float x = v[from];
        for (int i = from + 1; i < to; i++) if (v[i] != x) return false;
        return true;
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
        // Caso più comune: intonazione e posizione costanti nel blocco → pesi e incremento calcolati una volta
        bool fConst = (Frequency.Constant || Same(fq, from, to)) && (Detune.Constant || Same(dt, from, to));
        bool pConst = Position.Constant || Same(ps, from, to);
        float fRef = fq[from] * MathF.Pow(2, dt[from] / 1200f);
        if (fConst && pConst)
        {
            float x = Math.Clamp((ps[from] + 1) * 0.5f, 0, 1) * (F - 1);
            int k0 = Math.Min((int)x, F - 1), k1 = Math.Min(k0 + 1, F - 1);
            float w1 = x - k0, w0 = 1 - w1;
            var t0 = frames[k0].TableFor(Math.Abs(fRef), ny);
            double inc = fRef / sr, ph = phase;
            if (inc < 0) inc += Math.Ceiling(-inc);
            if (w1 <= 0 || k1 == k0)
            {
                for (int i = from; i < to; i++)
                {
                    double p = ph * PeriodicWave.Size;
                    int idx = (int)p; float fr = (float)(p - idx);
                    L[i] = t0[idx] + (t0[idx + 1] - t0[idx]) * fr;
                    ph += inc; if (ph >= 1) ph -= Math.Floor(ph);
                }
            }
            else
            {
                var t1 = frames[k1].TableFor(Math.Abs(fRef), ny);
                for (int i = from; i < to; i++)
                {
                    double p = ph * PeriodicWave.Size;
                    int idx = (int)p; float fr = (float)(p - idx);
                    float a0 = t0[idx] + (t0[idx + 1] - t0[idx]) * fr;
                    float a1 = t1[idx] + (t1[idx + 1] - t1[idx]) * fr;
                    L[i] = w0 * a0 + w1 * a1;
                    ph += inc; if (ph >= 1) ph -= Math.Floor(ph);
                }
            }
            phase = ph;
            return;
        }
        for (int k = 0; k < F; k++) tabs[k] = frames[k].TableFor(Math.Abs(fRef), ny);
        float f = fRef, inv = 1f / sr;
        for (int i = from; i < to; i++)
        {
            // Frequenza variabile (glide, modulazione di pitch): potenza ricalcolata ogni 8 campioni,
            // tabelle band-limited aggiornate ogni 32
            if (!fConst && ((i - from) & 7) == 0)
            {
                f = fq[i] * MathF.Pow(2, dt[i] / 1200f);
                if (((i - from) & 31) == 0) for (int k = 0; k < F; k++) tabs[k] = frames[k].TableFor(Math.Abs(f), ny);
            }
            float x = Math.Clamp((ps[i] + 1) * 0.5f, 0, 1) * (F - 1);
            int k0 = Math.Min((int)x, F - 1), k1 = k0 + 1 < F ? k0 + 1 : k0;
            float w1 = x - k0;
            double p = phase * PeriodicWave.Size;
            int idx = (int)p; float fr = (float)(p - idx);
            var t0 = tabs[k0]; var t1 = tabs[k1];
            float a0 = t0[idx] + (t0[idx + 1] - t0[idx]) * fr;
            float a1 = t1[idx] + (t1[idx + 1] - t1[idx]) * fr;
            L[i] = a0 + (a1 - a0) * w1;
            phase += f * inv;
            if (phase >= 1 || phase < 0) phase -= Math.Floor(phase);
        }
    }
}

public static class Wavetable
{
    const int H = 256, F = 4;
    const float EPS = 0.0001f;

    static (float[] re, float[] im) Dft(Func<double, double> fn, int N = 1024)
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

    static readonly Dictionary<string, (float[] re, float[] im)> coefs = new();
    /// <summary>Forma d'onda (un periodo, N punti) alla posizione `pos` della tabella: per il disegno nell'editor.</summary>
    public static float[] Shape(string table, double pos, int N = 200)
    {
        double x = Math.Clamp(pos, 0, 1) * (F - 1);
        var outp = new float[N];
        for (int k = 0; k < F; k++)
        {
            double w = Math.Max(0, 1 - Math.Abs(x - k));
            if (w == 0) continue;
            (float[] re, float[] im) c;
            lock (coefs) { if (!coefs.TryGetValue($"{table}|{k}", out c)) coefs[$"{table}|{k}"] = c = Gen(Tables.Contains(table) ? table : "analog", k); }
            var fr = new double[N]; double pk = 0;
            for (int i = 0; i < N; i++)
            {
                double v = 0;
                for (int n = 1; n < 64; n++) { double ph = 2 * Math.PI * n * i / N; v += c.re[n] * Math.Cos(ph) + c.im[n] * Math.Sin(ph); }
                fr[i] = v; pk = Math.Max(pk, Math.Abs(v));
            }
            for (int i = 0; i < N; i++) outp[i] += (float)(w * fr[i] / (pk > 0 ? pk : 1));
        }
        return outp;
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
        GainNode EnvNode(WtEnv e)
        {
            var g = ctx.Gain();
            double ea = e.A * p.Atk, ed = e.D * decMul;
            g.GainParam.SetValueAtTime(0, t);
            g.GainParam.LinearRampToValueAtTime(1, t + ea);
            g.GainParam.SetTargetAtTime((float)e.S, t + ea, Math.Max(0.01, ed / 3));
            one.Connect(g);
            return g;
        }
        var e2 = W.Env2;
        var env2 = EnvNode(e2);
        var envs = new List<(GainNode g, WtEnv e)> { (env2, e2) };
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
        if (used.Contains("lfo3")) src["lfo3"] = Lfo(W.Lfo3);
        if (used.Contains("lfo4")) src["lfo4"] = Lfo(W.Lfo4);
        if (used.Contains("env3")) { var g3 = EnvNode(W.Env3); src["env3"] = g3; envs.Add((g3, W.Env3)); }
        if (used.Contains("env4")) { var g4 = EnvNode(W.Env4); src["env4"] = g4; envs.Add((g4, W.Env4)); }
        for (int mi = 0; mi < 8; mi++)
            if (used.Contains($"m{mi + 1}")) { var mg = ctx.Gain((float)W.Macros[mi]); one.Connect(mg); src[$"m{mi + 1}"] = mg; }
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
            bool lfoLike = sname is "lfo1" or "lfo2" or "lfo3" or "lfo4" or "step";
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
            pre.Connect(ctx.Shaper(DriveCurve(W.Drive), 4)).Connect(comp);
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
        // Posizione non modulata: valore fisso sull'oscillatore (niente bus né sorgente costante)
        var posMod = W.Osc.Select((_, i) => W.Mod.Any(m => m.Amt != 0 && (m.Dst == "pos" || m.Dst == $"pos{i + 1}"))).ToArray();
        var posParams = new List<(AudioParam prm, double pos)>();
        var posBus = W.Osc.Select((o, i) =>
        {
            if (o.Level <= 0 || !posMod[i]) return null;
            var bus = ctx.Gain();
            var off = ctx.Constant((float)(Math.Clamp(o.Pos + p.Pos, 0, 1) * 2 - 1));
            posParams.Add((off.Offset, o.Pos));
            off.Connect(bus);
            sources.Add(off);
            return bus;
        }).ToArray();

        // Oscillatori
        var mix = ctx.Gain((float)(1 / (W.Osc.Sum(o => o.Level) is var al && al > 0 ? al : 1)));
        mix.Connect(pre);
        var pitchBus = ctx.Gain();
        bool pitchMod = W.Mod.Any(m => m.Dst == "pitch" && m.Amt != 0);
        var oscs = new List<SourceNode>();
        double glide = glideFrom != null && pr.Glide > 0 ? pr.Glide : 0;
        // Oscillatore di modulazione (uno per nota): ring mod sul volume, phase mod sulla frequenza
        bool pmDest = W.Mod.Any(m => m.Dst == "pm" && m.Amt != 0);
        bool useMO = W.Rm.Any(x => x > 0) || W.Pm.Any(x => x > 0) || pmDest;
        var modOsc = new Dictionary<int, AudioNode>();
        var pmNote = new Dictionary<int, GainNode>();
        var pmAmts = new List<GainNode>();
        AudioNode? ModOf(int n)
        {
            if (!useMO) return null;
            if (!modOsc.TryGetValue(n, out var mo))
            {
                var o = ctx.Oscillator(W.ModShape);
                o.Frequency.SetValueAtTime((float)Synth.Mtof(n + W.ModSemi), t);
                o.Detune.Value = (float)W.ModFine;
                if (pitchMod) pitchBus.Connect(o.Detune);
                oscs.Add(o);
                modOsc[n] = mo = o;
                var g = ctx.Gain(1);
                o.Connect(g);
                pmNote[n] = g;
                pmAmts.Add(g);
            }
            return mo;
        }
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
                var mo = ModOf(n);
                AudioNode dest = lvl;
                if (mo != null && W.Rm[i] > 0)
                {
                    var ring = ctx.Gain((float)(1 - W.Rm[i]));
                    mo.Connect(ctx.Gain((float)W.Rm[i])).Connect(ring.GainParam);
                    ring.Connect(lvl);
                    dest = ring;
                }
                GainNode? pmIn = null;
                if (mo != null && (W.Pm[i] > 0 || pmDest))
                {
                    pmIn = ctx.Gain((float)(W.Pm[i] * 3 * Synth.Mtof(n + o.Semi)));
                    pmNote[n].Connect(pmIn);
                }
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
                    if (pitchMod) pitchBus.Connect(osc.Detune);
                    if (posBus[i] is GainNode pb) { osc.Position.Value = 0; pb.Connect(osc.Position); }
                    else { osc.Position.Value = (float)(Math.Clamp(o.Pos + p.Pos, 0, 1) * 2 - 1); posParams.Add((osc.Position, o.Pos)); }
                    osc.Connect(dest);
                    if (pmIn != null) pmIn.Connect(osc.Frequency);
                    oscs.Add(osc);
                }
            }
        }
        GainNode? noiseGain = null;
        if (W.Noise > 0 || W.Mod.Any(m => m.Dst == "noise" && m.Amt != 0))
        {
            var nz = ctx.BufferSource(Kits.Noise(ctx));
            nz.Loop = true;
            noiseGain = ctx.Gain((float)(W.Noise * 0.6));
            nz.Connect(noiseGain).Connect(pre);
            sources.Add(nz);
        }

        // Matrice di modulazione
        double tremDepth = 0, envAmt = p.Env;
        foreach (var m in W.Mod)
        {
            if (!src.ContainsKey(m.Src) || m.Amt == 0) continue;
            double amt = m.Amt * (m.Src.StartsWith("env") ? envAmt : 1);
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
                case "pm": foreach (var g in pmAmts) Route(m.Src, g.GainParam, amt * 2); break;
                case "noise": if (noiseGain != null) Route(m.Src, noiseGain.GainParam, amt * 0.6); break;
                case "amp":
                {
                    bool bip = m.Src is "lfo1" or "lfo2" or "lfo3" or "lfo4";
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
            bool lfoLike = sname is "lfo1" or "lfo2" or "lfo3" or "lfo4" or "step";
            src[sname].Connect(ctx.Gain((float)(scale * (lfoLike ? modDepth : 1)))).Connect(bus);
        }

        foreach (var x in sources) x.Start(t);
        foreach (var x in oscs) x.Start(t);
        var all = sources.Concat(oscs).ToList();
        // Modifiche durante la nota: cutoff (spostamento in cent), risonanza, posizione nella tabella
        var p0 = p;
        void Tweak(VoiceParams q, double at)
        {
            float cents = accentCents + (float)((q.Cut - p0.Cut) * 3600);
            f1.Detune.SetTargetAtTime(cents, at, 0.015);
            f1.Q.SetTargetAtTime((float)Math.Min(25, W.F1.Res * Math.Pow(2, q.Res * 1.5)), at, 0.015);
            if (f2 != null) { f2.Detune.SetTargetAtTime(cents, at, 0.015); f2.Q.SetTargetAtTime((float)Math.Min(25, W.F2.Res * Math.Pow(2, q.Res * 1.5)), at, 0.015); }
            foreach (var (prm, basePos) in posParams) prm.SetTargetAtTime((float)(Math.Clamp(basePos + q.Pos, 0, 1) * 2 - 1), at, 0.02);
        }
        return Synth.MakeHandle(ctx, rel, all, r, t, dur, when => { foreach (var (g, e) in envs) g.GainParam.SetTargetAtTime(0, when, Math.Max(0.01, e.R / 3)); }, Tweak);
    }
}
