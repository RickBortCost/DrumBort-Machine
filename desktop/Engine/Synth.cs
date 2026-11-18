// Synth.cs — Voce synth sottrattiva/FM, corda pizzicata, piano additivo, organo a drawbar:
// porting 1:1 di playVoice (js/synth.js). I preset arrivano da Assets/presets.json.

using System.Text.Json.Nodes;
using DrumBort.Audio;

namespace DrumBort.Engine;

public interface IVoiceHandle
{
    void Release(double at);
    void Kill(double at);
}

public static class Synth
{
    public static readonly Dictionary<string, Preset> Presets = new();
    static readonly Dictionary<string, Preset> userPresets = new();

    public static void Load(string json)
    {
        Presets.Clear();
        foreach (var (id, n) in JsonNode.Parse(json)!.AsObject()) if (n != null) Presets[id] = Preset.Parse(id, n);
    }

    public static void SetUserPresets(JsonArray? list)
    {
        userPresets.Clear();
        if (list == null) return;
        foreach (var n in list)
        {
            var id = J.S(n, "id", "");
            if (id != "" && n!["wt"] != null) userPresets[id] = Preset.Parse(id, n);
        }
    }

    /// <summary>Preset effettivo: patch modificata, preset utente o di libreria.</summary>
    public static Preset? PresetOf(SynthTrack tr) =>
        tr.Patch ?? (Presets.TryGetValue(tr.Preset, out var p) ? p : userPresets.TryGetValue(tr.Preset, out var u) ? u : null);

    public static double ReleaseTime(Preset pr, VoiceParams p) => pr.R * Math.Sqrt(p.Dec) * p.Rel;
    public static double Mtof(double n) => 440 * Math.Pow(2, (n - 69) / 12);

    const float EPS = 0.0001f;

    // ---------------------------------------------------------------
    // Sorgenti generate (cache per preset/nota/sample rate)
    // ---------------------------------------------------------------
    static readonly Dictionary<string, AudioBuf> genCache = new();
    static Random rnd => Random.Shared;   // usato anche dal thread della cache

    static float[] GenPluck(int sr, double freq, GenDef g)
    {
        int N = Math.Max(2, (int)Math.Round(sr / freq));
        int total = (int)(sr * g.Len);
        var outp = new float[total];
        var buf = new float[N];
        double prev = 0, k = 0.15 + 0.85 * g.Bright;
        for (int i = 0; i < N; i++) { prev += (rnd.NextDouble() * 2 - 1 - prev) * k; buf[i] = (float)prev; }
        int idx = 0;
        for (int i = 0; i < total; i++)
        {
            float a = buf[idx], b = buf[idx + 1 == N ? 0 : idx + 1];
            outp[i] = a;
            buf[idx] = (float)(g.Damp * 0.5 * (a + b));
            idx = idx + 1 == N ? 0 : idx + 1;
        }
        return outp;
    }

    static float[] GenPiano(int sr, double freq, GenDef g)
    {
        int total = (int)(sr * g.Len);
        var outp = new double[total];
        int K = Math.Max(3, Math.Min(14, (int)(sr / 2.2 / freq)));
        double baseTau = g.Len * 0.45 * Math.Pow(261.6 / freq, 0.45);
        for (int k = 1; k <= K; k++)
        {
            double fk = k * freq * Math.Sqrt(1 + g.B * k * k);
            if (fk > sr / 2.2) break;
            double amp = Math.Pow(k, -(1.05 + (1 - g.Bright) * 0.9)) * (0.6 + 0.4 * Math.Abs(Math.Sin(k * 0.95)));
            double tau = baseTau / (1 + 0.3 * (k - 1));
            foreach (var det in new[] { 1, 1 + g.Beat })
            {
                double w = 2 * Math.PI * fk * det / sr, c = 2 * Math.Cos(w);
                double y1 = Math.Sin(-w), y2 = Math.Sin(-2 * w);
                double dec = Math.Exp(-1 / (tau * sr)), e = amp * 0.5;
                for (int i = 0; i < total; i++)
                {
                    double y = c * y1 - y2;
                    y2 = y1; y1 = y;
                    outp[i] += y * e;
                    e *= dec;
                }
            }
        }
        int thump = (int)(sr * 0.012);
        double lp = 0;
        for (int i = 0; i < thump && i < total; i++)
        {
            lp += (rnd.NextDouble() * 2 - 1 - lp) * 0.3;
            outp[i] += lp * 0.25 * (1 - (double)i / thump);
        }
        return outp.Select(x => (float)x).ToArray();
    }

    static AudioBuf GenBuffer(AudioContext ctx, Preset pr, int note)
    {
        string key = $"{pr.Id}|{note}|{ctx.SampleRate}";
        lock (genCache)
        {
            if (genCache.TryGetValue(key, out var b)) return b;
            double freq = Mtof(note);
            var data = pr.Gen!.Type == "piano" ? GenPiano(ctx.SampleRate, freq, pr.Gen) : GenPluck(ctx.SampleRate, freq, pr.Gen);
            float pk = 0;
            foreach (var x in data) pk = Math.Max(pk, Math.Abs(x));
            float norm = pk > 0 ? 0.9f / pk : 1;
            b = new AudioBuf(1, data.Length, ctx.SampleRate);
            for (int i = 0; i < data.Length; i++) b.Data[0][i] = data[i] * norm;
            if (genCache.Count > 400) genCache.Remove(genCache.Keys.First());
            genCache[key] = b;
            return b;
        }
    }

    // Organo: 9 drawbar → armoniche relative al 16'
    static readonly int[] DrawbarHarm = { 1, 3, 2, 4, 6, 8, 10, 12, 16 };
    static readonly Dictionary<string, PeriodicWave> organ = new();
    static PeriodicWave OrganWave(string reg)
    {
        lock (organ)
        {
            if (organ.TryGetValue(reg, out var w)) return w;
            var re = new float[17]; var im = new float[17];
            for (int i = 0; i < reg.Length && i < 9; i++) im[DrawbarHarm[i]] += (reg[i] - '0') / 8f;
            w = new PeriodicWave(re, im);
            organ[reg] = w;
            return w;
        }
    }

    static readonly Dictionary<int, float[]> drives = new();
    static float[] DriveCurve(double amount)
    {
        int key = (int)Math.Round(amount * 20);
        lock (drives)
        {
            if (!drives.TryGetValue(key, out var c))
            {
                int n = 1024; c = new float[n]; double k = 1 + amount * 8;
                for (int i = 0; i < n; i++) { double x = (double)i / (n - 1) * 2 - 1; c[i] = (float)(Math.Tanh(x * k) / Math.Tanh(k)); }
                drives[key] = c;
            }
            return c;
        }
    }

    /// <summary>Pre-calcola le tabelle delle forme d'onda usate dai preset.</summary>
    public static void Warm(float nyquist)
    {
        foreach (var t in new[] { "sine", "square", "sawtooth", "triangle" }) PeriodicWave.Builtin(t).Warm(nyquist);
        foreach (var p in Presets.Values)
            foreach (var o in p.Osc)
                if (o.Type.StartsWith("organ:")) OrganWave(o.Type[6..]).Warm(nyquist);
    }

    sealed class Handle : IVoiceHandle
    {
        public required AudioContext Ctx; public required GainNode Rel; public required List<SourceNode> Sources;
        public double R; public Action<double>? OnRelease;
        bool released;
        public void Release(double at)
        {
            if (released) return;
            released = true;
            double when = Math.Max(at, Ctx.CurrentTime);
            Rel.GainParam.SetValueAtTime(1, when);
            Rel.GainParam.SetTargetAtTime(0, when, Math.Max(0.005, R / 4));
            OnRelease?.Invoke(when);
            foreach (var s in Sources) s.Stop(when + R * 1.6 + 0.05);
        }
        public void Kill(double at)
        {
            double when = Math.Max(at, Ctx.CurrentTime);
            released = true;
            Rel.GainParam.SetTargetAtTime(0, when, 0.004);
            foreach (var s in Sources) s.Stop(when + 0.04);
        }
    }

    /// <summary>Handle di rilascio/taglio; con `dur` il rilascio è già pianificato a t + dur.</summary>
    internal static IVoiceHandle MakeHandle(AudioContext ctx, GainNode rel, List<SourceNode> sources, double r, double t, double? dur, Action<double>? onRelease = null)
    {
        var h = new Handle { Ctx = ctx, Rel = rel, Sources = sources, R = r, OnRelease = onRelease };
        if (dur != null) h.Release(t + Math.Max(0.01, dur.Value));
        return h;
    }

    /// <summary>Suona una voce (nota o accordo). dur = null: tenuta fino a Release().</summary>
    public static IVoiceHandle PlayVoice(AudioContext ctx, AudioNode outp, double t, double? dur, int[] notes, double vel, Preset pr, VoiceParams p, int? glideFrom)
    {
        if (pr.Wt != null) return Wavetable.Play(ctx, outp, t, dur, notes, vel, pr, p, glideFrom);
        bool accent = vel >= 0.95;
        double decMul = p.Dec;
        double a = pr.A * p.Atk, d = pr.D * decMul, s = pr.S, r = ReleaseTime(pr, p);
        double peak = (0.38 + vel * 0.3) / Math.Sqrt(notes.Length) * pr.Gain;
        var sources = new List<SourceNode>();

        var rel = ctx.Gain();
        rel.Connect(outp);
        AudioNode post = rel;

        // Tremolo / LFO
        var lfoCfg = pr.Lfo != null && p.Lfo > 0 ? pr.Lfo : null;
        GainNode? lfoGain = null;
        if (lfoCfg != null)
        {
            var lfo = ctx.Oscillator();
            lfo.Frequency.Value = (float)(lfoCfg.Rate * p.Rate);
            lfoGain = ctx.Gain();
            double depth = lfoCfg.Depth * p.Lfo;
            float lv = (float)(lfoCfg.To == "amp" ? depth / 2 : depth);
            if (lfoCfg.Delay > 0) { lfoGain.GainParam.SetValueAtTime(0, t); lfoGain.GainParam.LinearRampToValueAtTime(lv, t + lfoCfg.Delay); }
            else lfoGain.GainParam.Value = lv;
            lfo.Connect(lfoGain);
            sources.Add(lfo);
            if (lfoCfg.To == "amp")
            {
                var trem = ctx.Gain((float)(1 - Math.Min(0.95, depth) / 2));
                lfoGain.Connect(trem.GainParam);
                trem.Connect(rel);
                post = trem;
            }
        }

        // VCA
        var amp = ctx.Gain();
        amp.GainParam.SetValueAtTime(EPS, t);
        if (a >= 0.05) amp.GainParam.LinearRampToValueAtTime((float)peak, t + a);
        else amp.GainParam.ExponentialRampToValueAtTime((float)peak, t + Math.Max(0.002, a));
        amp.GainParam.SetTargetAtTime((float)Math.Max(EPS, peak * s), t + a, Math.Max(0.01, d / 3));
        amp.Connect(post);

        // Filtro con inviluppo
        var f = ctx.Biquad("lowpass");
        double bas = Math.Min(18000, pr.Cut * Math.Pow(2, p.Cut * 3));
        double envAmt = pr.EnvOct * p.Env * (accent ? 1.35 : 1);
        double top = Math.Min(18000, bas * Math.Pow(2, envAmt));
        f.Frequency.SetValueAtTime((float)bas, t);
        f.Frequency.ExponentialRampToValueAtTime((float)Math.Max(bas, top), t + Math.Max(0.003, a * 0.8));
        f.Frequency.SetTargetAtTime((float)bas, t + a, Math.Max(0.01, pr.Fdec * decMul * (accent ? 0.7 : 1) / 3));
        f.Q.Value = (float)Math.Min(25, pr.Res * Math.Pow(2, p.Res * 1.5) * (accent ? 1.2 : 1));
        f.Connect(amp);
        if (lfoGain != null && lfoCfg!.To == "cut")
        {
            var lg = ctx.Gain((float)bas);
            lfoGain.Connect(lg);
            lg.Connect(f.Frequency);
        }

        AudioNode dest = f;
        if (pr.Drive > 0) { var ws = ctx.Shaper(DriveCurve(pr.Drive), 4); ws.Connect(f); dest = ws; }

        if (pr.Formants != null)
        {
            var sum = ctx.Gain();
            sum.Connect(dest);
            var fin = ctx.Gain();
            foreach (var fm in pr.Formants)
            {
                var bp = ctx.Biquad("bandpass");
                bp.Frequency.Value = (float)fm[0]; bp.Q.Value = (float)fm[1];
                fin.Connect(bp).Connect(ctx.Gain((float)fm[2])).Connect(sum);
            }
            dest = fin;
        }

        if (pr.Noise != null)
        {
            var n = ctx.BufferSource(Kits.Noise(ctx));
            n.Loop = true;
            var hp = ctx.Biquad("highpass");
            hp.Frequency.Value = (float)(pr.Noise.Hp > 0 ? pr.Noise.Hp : 20);
            var ng = ctx.Gain();
            ng.GainParam.SetValueAtTime((float)pr.Noise.G, t);
            if (pr.Noise.D > 0) ng.GainParam.SetTargetAtTime(0, t, pr.Noise.D / 3);
            n.Connect(hp).Connect(ng).Connect(dest);
            sources.Add(n);
        }

        var mix = ctx.Gain((float)(1 / Math.Max(1, pr.Osc.Sum(o => o.G))));
        mix.Connect(dest);
        double glide = glideFrom != null && pr.Glide > 0 ? pr.Glide : 0;
        foreach (var note in notes)
        {
            if (pr.Gen != null)
            {
                var src = ctx.BufferSource(GenBuffer(ctx, pr, note));
                src.Connect(mix);
                sources.Add(src);
            }
            foreach (var o in pr.Osc)
            {
                var osc = ctx.Oscillator();
                bool isOrgan = o.Type.StartsWith("organ:");
                if (isOrgan) osc.SetPeriodicWave(OrganWave(o.Type[6..])); else osc.Type = o.Type;
                double target = Mtof(note + o.Oct * 12) / (isOrgan ? 2 : 1);
                if (glide > 0)
                {
                    osc.Frequency.SetValueAtTime((float)(Mtof(glideFrom!.Value + (note - notes[0]) + o.Oct * 12) / (isOrgan ? 2 : 1)), t);
                    osc.Frequency.ExponentialRampToValueAtTime((float)target, t + glide);
                }
                else osc.Frequency.SetValueAtTime((float)target, t);
                if (pr.Pitch != null)
                {
                    osc.Detune.SetValueAtTime((float)(o.Det + pr.Pitch.From * 100), t);
                    osc.Detune.LinearRampToValueAtTime((float)(o.Det + pr.Pitch.To * 100), t + pr.Pitch.Time);
                }
                else osc.Detune.Value = (float)o.Det;
                if (lfoGain != null && lfoCfg!.To == "pitch") lfoGain.Connect(osc.Detune);
                osc.Connect(ctx.Gain((float)o.G)).Connect(mix);
                if (pr.Fm != null)
                {
                    var mod = ctx.Oscillator();
                    mod.Frequency.SetValueAtTime((float)(target * pr.Fm.Ratio), t);
                    var mg = ctx.Gain();
                    double depth = target * pr.Fm.Index * (0.6 + vel * 0.4);
                    mg.GainParam.SetValueAtTime((float)depth, t);
                    mg.GainParam.SetTargetAtTime((float)(depth * 0.08), t, Math.Max(0.01, pr.Fm.Decay * decMul / 3));
                    mod.Connect(mg);
                    mg.Connect(osc.Frequency);
                    sources.Add(mod);
                }
                sources.Add(osc);
            }
        }
        foreach (var x in sources) x.Start(t);
        return MakeHandle(ctx, rel, sources, r, t, dur);
    }
}
