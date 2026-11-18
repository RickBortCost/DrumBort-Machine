// Mixer.cs — Porting di js/engine.js: 12 canali con insert e mandate, bus kit lo-fi,
// riverbero, delay, sidechain, filtro e compressore master, trigger e voice stealing.

using DrumBort.Audio;

namespace DrumBort.Engine;

public sealed class Fx
{
    public double Filter, Res = 0.7, Rev = 0.8, Size = 2.2, Dly = 0.7, Fb = 0.35, Div = 3, Master = 0.8, Sc, ScRel = 0.18;
    public static Fx Parse(System.Text.Json.Nodes.JsonNode? n) => new()
    {
        Filter = J.D(n, "filter", 0), Res = J.D(n, "res", 0.7), Rev = J.D(n, "rev", 0.8), Size = J.D(n, "size", 2.2),
        Dly = J.D(n, "dly", 0.7), Fb = J.D(n, "fb", 0.35), Div = J.D(n, "div", 3), Master = J.D(n, "master", 0.8),
        Sc = J.D(n, "sc", 0), ScRel = J.D(n, "scRel", 0.18),
    };
    public Fx Clone() => (Fx)MemberwiseClone();
}

public sealed class Mixer
{
    public const int Tracks = 8, SynthCh = 8, Channels = 12;
    const int CH = 3, OH = 4;
    public readonly AudioContext Ctx;
    sealed class Channel
    {
        public required GainNode Gain; public required StereoPannerNode Pan; public required GainNode Rev, Dly;
        public List<AudioNode> Ins = new(); public double Drv = -1; public int Crush = -1;
    }
    readonly Channel[] ch = new Channel[Channels];
    readonly GainNode master, kitIn, kitOut, revIn, revOut, dlyIn, dlyFb, dlyOut, duck;
    readonly BiquadFilterNode lp, hp, dlyTone;
    readonly CompressorNode comp;
    readonly ReverbNode reverb;
    readonly DelayNode delay;
    readonly List<AudioNode> kitInserts = new();
    KitDef? chainKit;
    public KitDef Kit;
    public Fx Fx = new();
    public double Bpm = 120;
    double revSize = -1;

    sealed class Voice { public required GainNode G; public required VoiceScope Scope; public IVoiceHandle? Handle; public double End; }
    readonly Voice?[] drum = new Voice?[Tracks];
    readonly Voice?[] mono = new Voice?[2];
    readonly List<Voice>[] poly = { new(), new(), new(), new() };
    readonly List<Voice> live = new();
    public readonly float[] Peaks = new float[Channels + 1];
    /// <summary>Voci pre-renderizzate (null = sempre sintesi dal vivo, es. render offline).</summary>
    public VoiceCache? Cache;

    public Mixer(AudioContext ctx)
    {
        Ctx = ctx;
        Kit = Kits.All[0];
        comp = new CompressorNode(ctx);
        master = ctx.Gain();
        master.Connect(comp).Connect(ctx.Destination);
        lp = ctx.Biquad("lowpass"); hp = ctx.Biquad("highpass");
        lp.Connect(hp).Connect(master);
        kitIn = ctx.Gain(0.85f); kitOut = ctx.Gain();
        kitOut.Connect(lp);
        revIn = ctx.Gain(); reverb = new ReverbNode(ctx); revOut = ctx.Gain();
        revIn.Connect(reverb).Connect(revOut).Connect(lp);
        dlyIn = ctx.Gain(); delay = ctx.Delay(4); dlyFb = ctx.Gain();
        dlyTone = ctx.Biquad("lowpass"); dlyTone.Frequency.Value = 4500;
        dlyOut = ctx.Gain();
        dlyIn.Connect(delay);
        delay.Connect(dlyTone).Connect(dlyFb).Connect(delay);
        delay.Connect(dlyOut).Connect(lp);
        duck = ctx.Gain();
        duck.Connect(lp);
        for (int i = 0; i < Channels; i++)
        {
            var gain = ctx.Gain(); var pan = ctx.Panner();
            pan.Connect(i < Tracks ? kitIn : duck);
            var rev = ctx.Gain(0); var dly = ctx.Gain(0);
            pan.Connect(rev).Connect(revIn);
            pan.Connect(dly).Connect(dlyIn);
            ch[i] = new Channel { Gain = gain, Pan = pan, Rev = rev, Dly = dly };
            SetInserts(ch[i], 0, 0);
        }
        BuildKitChain();
        SetFx(Fx, 120, true);
    }

    /// <summary>Solo test: esclude il compressore master.</summary>
    public void BypassCompressor() { master.Disconnect(); master.Connect(Ctx.Destination); }

    // ----- Kit e catena lo-fi -----
    public void SetKit(KitDef k) { Kit = k; SetChainKit(k); }
    public void SetChainKit(KitDef k) { if (chainKit == k) return; chainKit = k; BuildKitChain(); }

    void BuildKitChain()
    {
        var kit = chainKit ?? Kit;
        kitIn.Disconnect();
        foreach (var n in kitInserts) n.Disconnect();
        kitInserts.Clear();
        AudioNode node = kitIn;
        if (kit.Lp > 0)
        {
            var f = Ctx.Biquad("lowpass"); f.Frequency.Value = (float)kit.Lp; f.Q.Value = 0.5f;
            node.Connect(f); node = f; kitInserts.Add(f);
        }
        if (kit.Crush > 0) { var ws = Ctx.Shaper(CrushCurve(kit.Crush)); node.Connect(ws); node = ws; kitInserts.Add(ws); }
        node.Connect(kitOut);
    }

    static readonly Dictionary<int, float[]> crush = new(), drive = new();
    static float[] CrushCurve(int bits)
    {
        if (!crush.TryGetValue(bits, out var c))
        {
            int n = 65536; c = new float[n]; double steps = Math.Pow(2, bits - 1);
            for (int i = 0; i < n; i++) { double x = (double)i / (n - 1) * 2 - 1; c[i] = (float)(Math.Round(x * steps) / steps); }
            crush[bits] = c;
        }
        return c;
    }
    static float[] DriveCurve(double amount)
    {
        int key = (int)Math.Round(amount * 20);
        if (!drive.TryGetValue(key, out var c))
        {
            int n = 2048; c = new float[n]; double k = 1 + amount * 12;
            for (int i = 0; i < n; i++) { double x = (double)i / (n - 1) * 2 - 1; c[i] = (float)(Math.Tanh(x * k) / Math.Tanh(k)); }
            drive[key] = c;
        }
        return c;
    }

    // ----- Mixer ed effetti -----
    public void SetChannel(int i, double vol, double pan, double rev, double dly, double drv, int crushBits, double time)
    {
        var c = ch[i];
        double t = Math.Max(time, Ctx.CurrentTime);
        c.Gain.GainParam.SetTargetAtTime((float)(vol * vol * 1.2), t, 0.01);
        c.Pan.Pan.SetTargetAtTime((float)pan, t, 0.01);
        c.Rev.GainParam.SetTargetAtTime((float)rev, t, 0.01);
        c.Dly.GainParam.SetTargetAtTime((float)dly, t, 0.01);
        SetInserts(c, Math.Round(drv * 20) / 20, crushBits);
    }

    void SetInserts(Channel c, double drv, int crushBits)
    {
        if (c.Drv == drv && c.Crush == crushBits) return;
        c.Drv = drv; c.Crush = crushBits;
        c.Gain.Disconnect();
        foreach (var n in c.Ins) n.Disconnect();
        c.Ins.Clear();
        AudioNode node = c.Gain;
        if (drv > 0)
        {
            var ws = Ctx.Shaper(DriveCurve(drv));
            var comp = Ctx.Gain((float)(1 / (1 + drv * 1.5)));
            node.Connect(ws).Connect(comp);
            node = comp;
            c.Ins.Add(ws); c.Ins.Add(comp);
        }
        if (crushBits > 0) { var ws = Ctx.Shaper(CrushCurve(crushBits)); node.Connect(ws); node = ws; c.Ins.Add(ws); }
        node.Connect(c.Pan);
    }

    public void ApplyMix(Pattern p, double time)
    {
        for (int i = 0; i < Tracks; i++) { var t = p.Tracks[i]; SetChannel(i, t.Vol, t.Pan, t.Rev, t.Dly, t.Drv, t.Crush, time); }
        for (int k = 0; k < 4; k++) { var t = p.Synth.Tracks[k]; SetChannel(SynthCh + k, t.Vol, t.Pan, t.Rev, t.Dly, t.Drv, t.Crush, time); }
    }

    public static (double lp, double hp) FilterFreqs(double f) =>
        (f < -0.02 ? 20000 * Math.Pow(80.0 / 20000, -f) : 20000, f > 0.02 ? 20 * Math.Pow(6000.0 / 20, f) : 10);

    public void SetFx(Fx f, double bpm, bool immediate = false)
    {
        Fx = f;
        if (bpm > 0) Bpm = bpm;
        double t = Ctx.CurrentTime, tc = immediate ? 0.001 : 0.03;
        var (l, h) = FilterFreqs(f.Filter);
        lp.Frequency.SetTargetAtTime((float)l, t, tc);
        hp.Frequency.SetTargetAtTime((float)h, t, tc);
        lp.Q.Value = (float)(f.Filter < -0.02 ? f.Res : 0.7);
        hp.Q.Value = (float)(f.Filter > 0.02 ? f.Res : 0.7);
        master.GainParam.SetTargetAtTime((float)f.Master, t, tc);
        revOut.GainParam.SetTargetAtTime((float)f.Rev, t, tc);
        dlyOut.GainParam.SetTargetAtTime((float)f.Dly, t, tc);
        dlyFb.GainParam.SetTargetAtTime((float)Math.Min(0.9, f.Fb), t, tc);
        delay.DelayTime.SetTargetAtTime((float)Math.Min(4, 60 / Bpm / 4 * f.Div), t, immediate ? 0.001 : 0.05);
        if (Math.Abs(f.Size - revSize) > 0.05) { revSize = f.Size; reverb.SetSize(f.Size); }
    }

    /// <summary>Filtro/risonanza dal vivo (pad XY): non tocca il resto degli effetti.</summary>
    public void SetLiveFilter(double filter, double res)
    {
        var f = Fx.Clone(); f.Filter = filter; f.Res = res;
        SetFx(f, 0);
    }

    // ----- Voci -----
    Voice NewVoice(AudioNode dest, out GainNode g)
    {
        g = Ctx.Gain();
        g.Connect(dest);
        var v = new Voice { G = g, Scope = new VoiceScope() };
        live.Add(v);
        Ctx.Scope = v.Scope;
        return v;
    }

    void Kill(Voice v, double t, double tc = 0.004)
    {
        v.G.GainParam.SetTargetAtTime(0, t, tc);
        if (v.Handle != null) v.Handle.Kill(t);
        else foreach (var s in v.Scope.Sources) s.Stop(t + tc * 10);
    }

    public void Trigger(int i, double time, double vel, DrumTrack p, KitDef? voiceKit = null)
    {
        var kit = voiceKit ?? Kit;
        double t = Math.Max(time, Ctx.CurrentTime);
        if (i == 0 && Fx.Sc > 0)
        {
            var d = duck.GainParam;
            d.CancelScheduledValues(t);
            d.SetValueAtTime((float)Math.Max(0.05, 1 - 0.95 * Fx.Sc * Math.Min(1, vel / 0.62)), t);
            d.SetTargetAtTime(1, t + 0.01, Math.Max(0.02, Fx.ScRel / 3));
        }
        if (drum[i] != null) Kill(drum[i]!, t);
        if (i == CH && drum[OH] != null) { Kill(drum[OH]!, t, 0.008); drum[OH] = null; }
        var v = NewVoice(ch[i].Gain, out var g);
        try
        {
            string? key = Cache != null ? DrumKey(kit, i, p) : null;
            if (key != null && Cache!.TryGet(key, out var buf))
            {
                g.GainParam.Value = (float)vel;
                var src = Ctx.BufferSource(buf);
                src.Connect(g);
                src.Start(t, 0);
                src.Stop(t + buf.Duration);
            }
            else
            {
                kit.Tracks[i].Play(Ctx, g, t, vel, p.Tune, p.Decay);
                if (key != null) RequestDrum(kit, i, p.Tune, p.Decay, key);
            }
        }
        finally { Ctx.Scope = null; }
        drum[i] = v;
    }

    static string DrumKey(KitDef kit, int i, DrumTrack p) => $"d|{kit.Id}{(kit.Id.StartsWith("u:") ? $"#{Kits.UserRev}" : "")}|{i}|{p.Tune}|{p.Decay}";

    void RequestDrum(KitDef kit, int i, double tune, double decay, string key)
    {
        var play = kit.Tracks[i].Play;
        Cache!.Request(key, Math.Min(8, 1 + 3 * decay), (c, o) => play(c, o, 0, 1, tune, decay));
    }

    static string SynthKey(SynthTrack tr, Preset pr, int[] notes, double dur, double vel, int? glideFrom, double bpm)
    {
        var p = tr.Params(bpm);
        string tempo = pr.Wt != null ? $"|{bpm}" : "";
        return $"s|{tr.Preset}#{pr.Hash}|{string.Join(',', notes)}|{Math.Round(dur * 1000)}|{vel:F3}|{p.Cut}|{p.Res}|{p.Env}|{p.Dec}|{p.Atk}|{p.Rel}|{p.Lfo}|{p.Rate}|{p.Pos}|{glideFrom}{tempo}";
    }

    void RequestSynth(SynthTrack tr, Preset pr, int[] notes, double dur, double vel, int? glideFrom, string key)
    {
        var vp = tr.Params(Bpm);
        double rel = pr.Wt != null ? pr.R * Math.Sqrt(vp.Dec) * vp.Rel : Synth.ReleaseTime(pr, vp);
        Cache!.Request(key, Math.Min(12, dur + rel * 1.7 + 0.1), (c, o) => Synth.PlayVoice(c, o, 0, dur, notes, vel, pr, vp, glideFrom));
    }

    /// <summary>Pre-renderizza in background le voci di un pattern (batteria e note synth).</summary>
    public void Prewarm(Pattern pat, Func<Pattern, int, int, (int[] notes, double dur, double vel, int? glide, SynthTrack tr)?> synthEvent)
    {
        if (Cache == null) return;
        for (int i = 0; i < Tracks; i++)
        {
            var kit = pat.Kits?[i] ?? Kit;
            var tr = pat.Tracks[i];
            RequestDrumIfMissing(kit, i, tr);
            for (int s = 0; s < 16; s++)
            {
                var o = pat.Opts[i][s];
                if (o != null && pat.Steps[i][s] > 0 && (o.Tune != null || o.Decay != null)) RequestDrumIfMissing(kit, i, tr.With(o));
            }
        }
        for (int k = 0; k < 4; k++)
        {
            var tr = pat.Synth.Tracks[k];
            if (tr.Arp.On) continue;
            for (int s = 0; s < Math.Max(1, tr.Len); s++)
            {
                if (synthEvent(pat, k, s) is not var (notes, dur, vel, glide, t2)) continue;
                var pr = Synth.PresetOf(t2);
                if (pr == null) continue;
                string key = SynthKey(t2, pr, notes, dur, vel, glide, Bpm);
                if (!Cache.TryGet(key, out _)) RequestSynth(t2, pr, notes, dur, vel, glide, key);
            }
        }
    }

    void RequestDrumIfMissing(KitDef kit, int i, DrumTrack p)
    {
        string key = DrumKey(kit, i, p);
        if (!Cache!.TryGet(key, out _)) RequestDrum(kit, i, p.Tune, p.Decay, key);
    }

    public IVoiceHandle? PlaySynth(int k, double time, double? dur, int[] notes, double vel, SynthTrack tr, int? glideFrom = null)
    {
        var pr = Synth.PresetOf(tr);
        if (pr == null) return null;
        double t = Math.Max(time, Ctx.CurrentTime);
        bool isMono = SynthDefs.Tracks[k].Mono;
        if (isMono) { if (mono[k] != null) Kill(mono[k]!, t, 0.006); }
        else
        {
            poly[k].RemoveAll(x => x.End <= t);
            while (poly[k].Count >= 3) { Kill(poly[k][0], t, 0.04); poly[k].RemoveAt(0); }
        }
        var vp = tr.Params(Bpm);
        double rel = pr.Wt != null ? pr.R * Math.Sqrt(vp.Dec) * vp.Rel : Synth.ReleaseTime(pr, vp);
        var v = NewVoice(ch[SynthCh + k].Gain, out var g);
        try
        {
            string? key = Cache != null && dur != null ? SynthKey(tr, pr, notes, dur.Value, vel, glideFrom, Bpm) : null;
            if (key != null && Cache!.TryGet(key, out var buf))
            {
                var src = Ctx.BufferSource(buf);
                src.Connect(g);
                src.Start(t, 0);
                src.Stop(t + buf.Duration);
                v.End = t + buf.Duration;
            }
            else
            {
                v.Handle = Synth.PlayVoice(Ctx, g, t, dur, notes, vel, pr, vp, glideFrom);
                if (key != null) RequestSynth(tr, pr, notes, dur!.Value, vel, glideFrom, key);
            }
        }
        finally { Ctx.Scope = null; }
        if (v.End == 0) v.End = dur != null ? t + dur.Value + rel * 1.7 : double.MaxValue;
        if (isMono) mono[k] = v; else poly[k].Add(v);
        return v.Handle ?? new CachedHandle(this, v);
    }

    /// <summary>Handle di una voce da cache: il rilascio è già nel buffer, si può solo tagliare.</summary>
    sealed class CachedHandle : IVoiceHandle
    {
        readonly Mixer m; readonly Voice v;
        public CachedHandle(Mixer m, Voice v) { this.m = m; this.v = v; }
        public void Release(double at) { }
        public void Kill(double at) => m.Kill(v, at);
    }

    /// <summary>Click del metronomo (dopo il compressore, fuori dagli effetti).</summary>
    public void Click(double time, bool accent)
    {
        var v = NewVoice(Ctx.Destination, out var g);
        try
        {
            var o = Ctx.Oscillator();
            o.Frequency.Value = accent ? 1760 : 1175;
            var a = Ctx.Gain();
            a.GainParam.SetValueAtTime(0.0001f, time);
            a.GainParam.ExponentialRampToValueAtTime(accent ? 0.5f : 0.3f, time + 0.001);
            a.GainParam.ExponentialRampToValueAtTime(0.0001f, time + 0.04);
            o.Connect(a).Connect(g);
            o.Start(time); o.Stop(time + 0.05);
        }
        finally { Ctx.Scope = null; }
    }

    /// <summary>Stacca le voci finite (sorgenti ferme da più di 0,5 s) e aggiorna i picchi.</summary>
    public void AfterBlock()
    {
        double now = Ctx.CurrentTime;
        for (int i = live.Count - 1; i >= 0; i--)
        {
            var v = live[i];
            if (v.Scope.Finished(now, 0.5)) { v.G.Disconnect(); live.RemoveAt(i); }
        }
        for (int i = 0; i < Channels; i++) Peaks[i] = Math.Max(Peak(ch[i].Pan), Peaks[i] * 0.9f);
        Peaks[Channels] = Math.Max(Peak(comp), Peaks[Channels] * 0.9f);
    }
    static float Peak(AudioNode n)
    {
        float pk = 0;
        for (int i = 0; i < AudioContext.Block; i++) { pk = Math.Max(pk, Math.Abs(n.L[i])); if (n.Stereo) pk = Math.Max(pk, Math.Abs(n.R[i])); }
        return pk;
    }
    public int LiveVoices => live.Count;
}
