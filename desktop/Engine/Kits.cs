// Kits.cs — Voci di batteria: porting 1:1 delle factory di js/kits.js. Le definizioni dei kit
// arrivano da Assets/kits.json (generato dalla web app con tools/export-dsp.mjs).

using System.Text.Json.Nodes;
using DrumBort.Audio;

namespace DrumBort.Engine;

public delegate void Voice(AudioContext ctx, AudioNode outp, double t, double v, double tune, double decay);

public sealed class KitTrack
{
    public string Name = "", Short = ""; public double Pan;
    public Voice Play = (_, _, _, _, _, _) => { };
}

public sealed class KitDef
{
    public string Id = "", Name = ""; public string? Group; public int Bpm = 120, Swing = 50, Crush; public double Lp;
    public KitTrack[] Tracks = Array.Empty<KitTrack>();
}

public static class Kits
{
    public static readonly List<KitDef> All = new();
    static readonly Dictionary<string, KitDef> user = new();

    public static KitDef ById(string id) =>
        All.FirstOrDefault(k => k.Id == id) ?? (user.TryGetValue(id, out var u) ? u : All[0]);

    public static void Load(string json)
    {
        All.Clear();
        foreach (var k in JsonNode.Parse(json)!.AsArray())
        {
            All.Add(new KitDef
            {
                Id = J.S(k, "id", ""), Name = J.S(k, "name", ""), Group = J.S(k, "group", "") is var g && g != "" ? g : null,
                Bpm = J.I(k, "bpm", 120), Swing = J.I(k, "swing", 50), Crush = J.I(k, "crush", 0), Lp = J.D(k, "lp", 0),
                Tracks = k!["tracks"]!.AsArray().Select(t => new KitTrack
                {
                    Name = J.S(t, "name", ""), Short = J.S(t, "short", ""), Pan = J.D(t, "pan", 0), Play = Build(t!["voice"]),
                }).ToArray(),
            });
        }
    }

    static readonly Dictionary<string, KitTrack> sounds = new();
    /// <summary>Cambia a ogni aggiornamento di suoni/kit utente (chiave della cache delle voci).</summary>
    public static int UserRev;
    public static int UserSoundCount => sounds.Count;

    /// <summary>Suoni di batteria creati nel Sound Lab: { id, name, short, spec }.</summary>
    public static void SetUserSounds(JsonArray? list)
    {
        sounds.Clear();
        UserRev++;
        if (list == null) return;
        foreach (var s in list)
        {
            var id = J.S(s, "id", "");
            if (id == "" || s?["spec"] == null) continue;
            sounds[id] = new KitTrack { Name = J.S(s, "name", "Suono"), Short = J.S(s, "short", "US"), Play = Build(s["spec"]) };
        }
    }

    /// <summary>Kit personalizzati: voci prese da kit diversi o dal Sound Lab (come buildUserKit nella web app).</summary>
    public static void SetUserKits(JsonArray? defs)
    {
        user.Clear();
        UserRev++;
        if (defs == null) return;
        foreach (var d in defs)
        {
            if (d?["map"] is not JsonArray map || map.Count != 8) continue;
            var first = map.FirstOrDefault(m => J.S(m, "kit", "") != "");
            var baseKit = All.FirstOrDefault(k => k.Id == J.S(first, "kit", "")) ?? All[0];
            var kit = new KitDef
            {
                Id = J.S(d, "id", ""), Name = J.S(d, "name", ""), Bpm = baseKit.Bpm, Swing = baseKit.Swing,
                Crush = J.I(d, "crush", 0), Lp = J.I(d, "crush", 0) > 0 ? 12000 : 0,
                Tracks = map.Select((m, i) =>
                {
                    if (sounds.TryGetValue(J.S(m, "sound", ""), out var snd))
                        return new KitTrack { Name = snd.Name, Short = snd.Short, Play = snd.Play, Pan = baseKit.Tracks[i].Pan };
                    var src = All.FirstOrDefault(k => k.Id == J.S(m, "kit", "")) ?? baseKit;
                    int ti = J.I(m, "track", i);
                    return ti >= 0 && ti < src.Tracks.Length ? src.Tracks[ti] : baseKit.Tracks[i];
                }).ToArray(),
            };
            user[kit.Id] = kit;
        }
    }

    // =================================================================
    // Helper (come in kits.js)
    // =================================================================
    const float EPS = 0.0001f;
    static readonly double[] Metal808 = { 205.3, 304.4, 369.6, 522.7, 540, 800 };

    static readonly Dictionary<int, AudioBuf> noise = new();
    public static AudioBuf Noise(AudioContext ctx)
    {
        lock (noise)
        {
            if (!noise.TryGetValue(ctx.SampleRate, out var b))
            {
                b = new AudioBuf(1, ctx.SampleRate * 2, ctx.SampleRate);
                var r = new Random(1234);
                for (int i = 0; i < b.Length; i++) b.Data[0][i] = (float)(r.NextDouble() * 2 - 1);
                noise[ctx.SampleRate] = b;
            }
            return b;
        }
    }

    static readonly Dictionary<double, float[]> drives = new();
    static float[] DriveCurve(double amount)
    {
        lock (drives)
        {
            if (!drives.TryGetValue(amount, out var c))
            {
                int n = 2048; c = new float[n]; double k = 1 + amount * 6;
                for (int i = 0; i < n; i++) { double x = (double)i / (n - 1) * 2 - 1; c[i] = (float)(Math.Tanh(x * k) / Math.Tanh(k)); }
                drives[amount] = c;
            }
            return c;
        }
    }

    static GainNode Vca(AudioContext ctx, AudioNode outp, double t, double peak, double dur, double attack = 0.001)
    {
        var g = ctx.Gain();
        g.GainParam.SetValueAtTime(EPS, t);
        g.GainParam.ExponentialRampToValueAtTime((float)Math.Max(peak, EPS * 2), t + attack);
        g.GainParam.ExponentialRampToValueAtTime(EPS, t + attack + Math.Max(dur, 0.005));
        g.Connect(outp);
        return g;
    }

    static BufferSourceNode NoiseSrc(AudioContext ctx, double t, double dur)
    {
        var s = ctx.BufferSource(Noise(ctx));
        s.Loop = true;
        s.Start(t, Random.Shared.NextDouble() * 1.5);
        s.Stop(t + dur + 0.05);
        return s;
    }

    static BiquadFilterNode Filt(AudioContext ctx, string type, double freq, double q = 0.7)
    {
        var f = ctx.Biquad(type);
        f.Frequency.Value = (float)Math.Min(freq, ctx.SampleRate / 2.0 - 100);
        f.Q.Value = (float)q;
        return f;
    }

    static OscillatorNode Osc(AudioContext ctx, string type, double freq, double t, double dur)
    {
        var o = ctx.Oscillator(type);
        o.Frequency.SetValueAtTime((float)freq, t);
        o.Start(t);
        o.Stop(t + dur + 0.05);
        return o;
    }

    static double Ratio(double tune) => Math.Pow(2, tune / 12);

    // =================================================================
    // Factory
    // =================================================================
    static Voice Build(JsonNode? spec)
    {
        string type = J.S(spec, "type", "kick");
        if (type == "layer")
        {
            var vs = (spec!["voices"] as JsonArray ?? new JsonArray()).Select(Build).ToArray();
            return (ctx, o, t, v, tune, dec) => { foreach (var x in vs) x(ctx, o, t, v, tune, dec); };
        }
        var o = spec?["o"];
        double D(string k, double def) => J.D(o, k, def);
        double[] Arr(string k, double[] def) => o?[k] is JsonArray a ? J.Nums(a) : def;
        string S(string k, string def) => J.S(o, k, def);

        switch (type)
        {
            case "kick":
            {
                double start = D("start", 150), end = D("end", 50), sweep = D("sweep", 0.05), decay = D("decay", 0.5), click = D("click", 0),
                    drive = D("drive", 0), noiseL = D("noise", 0), noiseFreq = D("noiseFreq", 1500), level = D("level", 1);
                string ot = S("type", "sine");
                return (ctx, outp, t, v, tune, dm) =>
                {
                    double k = Ratio(tune), dur = decay * dm;
                    var amp = Vca(ctx, outp, t, v * level, dur, 0.0015);
                    var osc = Osc(ctx, ot, start * k, t, dur);
                    osc.Frequency.ExponentialRampToValueAtTime((float)(end * k), t + sweep);
                    if (drive > 0) osc.Connect(ctx.Shaper(DriveCurve(drive), 4)).Connect(amp);
                    else osc.Connect(amp);
                    if (click > 0)
                    {
                        var g = Vca(ctx, outp, t, v * click, 0.01);
                        NoiseSrc(ctx, t, 0.02).Connect(Filt(ctx, "highpass", 2500)).Connect(g);
                    }
                    if (noiseL > 0)
                    {
                        var g = Vca(ctx, outp, t, v * noiseL, dur * 0.4);
                        NoiseSrc(ctx, t, dur).Connect(Filt(ctx, "bandpass", noiseFreq, 1)).Connect(g);
                    }
                };
            }
            case "snare":
            {
                double[] tones = Arr("tones", new double[] { 180, 330 });
                string oscType = S("oscType", "triangle"), nType = S("nType", "highpass");
                double drop = D("drop", 1.4), sweep = D("sweep", 0.03), toneDecay = D("toneDecay", 0.12), toneLevel = D("toneLevel", 0.6),
                    nFreq = D("nFreq", 1800), nQ = D("nQ", 0.7), nDecay = D("nDecay", 0.18), noiseLevel = D("noiseLevel", 0.7);
                return (ctx, outp, t, v, tune, d) =>
                {
                    double k = Ratio(tune);
                    var bus = ctx.Gain();
                    bus.Connect(outp);
                    var tg = Vca(ctx, bus, t, v * toneLevel / tones.Length, toneDecay * d);
                    foreach (var f in tones)
                    {
                        var osc = Osc(ctx, oscType, f * k * drop, t, toneDecay * d);
                        osc.Frequency.ExponentialRampToValueAtTime((float)(f * k), t + sweep);
                        osc.Connect(tg);
                    }
                    var ng = Vca(ctx, bus, t, v * noiseLevel, nDecay * d);
                    NoiseSrc(ctx, t, nDecay * d).Connect(Filt(ctx, nType, nFreq * k, nQ)).Connect(ng);
                };
            }
            case "clap":
            {
                double freq = D("freq", 1100), q = D("q", 1.2), spacing = D("spacing", 0.011), burstDecay = D("burstDecay", 0.008),
                    tail = D("tail", 0.18), level = D("level", 0.9);
                int bursts = (int)D("bursts", 3);
                return (ctx, outp, t, v, tune, d) =>
                {
                    double k = Ratio(tune);
                    var g = ctx.Gain();
                    var gp = g.GainParam;
                    gp.SetValueAtTime(EPS, t);
                    for (int i = 0; i < bursts; i++)
                    {
                        double bt = t + i * spacing;
                        gp.SetValueAtTime((float)(v * level), bt);
                        gp.ExponentialRampToValueAtTime((float)(v * level * 0.08 + EPS), bt + burstDecay);
                    }
                    double tt = t + bursts * spacing;
                    gp.SetValueAtTime((float)(v * level * 0.75), tt);
                    gp.ExponentialRampToValueAtTime(EPS, tt + tail * d);
                    NoiseSrc(ctx, t, bursts * spacing + tail * d).Connect(Filt(ctx, "bandpass", freq * k, q)).Connect(g).Connect(outp);
                };
            }
            case "rim":
            {
                double[] freqs = Arr("freqs", new double[] { 500, 1700 });
                string ot = S("type", "square");
                double decay = D("decay", 0.035), hp = D("hp", 600), level = D("level", 0.5);
                return (ctx, outp, t, v, tune, dm) =>
                {
                    double k = Ratio(tune), dur = decay * dm;
                    var amp = Vca(ctx, outp, t, v * level / freqs.Length, dur);
                    AudioNode dest = amp;
                    if (hp > 0) { var h = Filt(ctx, "highpass", hp * k); h.Connect(amp); dest = h; }
                    foreach (var f in freqs) Osc(ctx, ot, f * k, t, dur).Connect(dest);
                };
            }
            case "metal":
            {
                double[] freqs = Arr("freqs", Metal808);
                string ot = S("type", "square");
                double mult = D("mult", 1), bp = D("bp", 10000), bpQ = D("bpQ", 1), hp = D("hp", 7000), decay = D("decay", 0.06),
                    level = D("level", 0.5), noiseL = D("noise", 0), attack = D("attack", 0.001);
                return (ctx, outp, t, v, tune, dm) =>
                {
                    double k = Ratio(tune) * mult, dur = decay * dm;
                    var amp = Vca(ctx, outp, t, v * level, dur, attack);
                    var b = Filt(ctx, "bandpass", bp, bpQ);
                    var h = Filt(ctx, "highpass", hp);
                    b.Connect(h).Connect(amp);
                    var og = ctx.Gain((float)(1.0 / freqs.Length));
                    og.Connect(b);
                    foreach (var f in freqs) Osc(ctx, ot, f * k, t, dur).Connect(og);
                    if (noiseL > 0) NoiseSrc(ctx, t, dur).Connect(ctx.Gain((float)noiseL)).Connect(b);
                };
            }
            case "tom":
            {
                double start = D("start", 200), end = D("end", 120), sweep = D("sweep", 0.15), decay = D("decay", 0.4),
                    noiseL = D("noise", 0), noiseFreq = D("noiseFreq", 1200), level = D("level", 0.9);
                string ot = S("type", "sine");
                return (ctx, outp, t, v, tune, dm) =>
                {
                    double k = Ratio(tune), dur = decay * dm;
                    var amp = Vca(ctx, outp, t, v * level, dur, 0.002);
                    var osc = Osc(ctx, ot, start * k, t, dur);
                    osc.Frequency.ExponentialRampToValueAtTime((float)(end * k), t + sweep);
                    osc.Connect(amp);
                    if (noiseL > 0)
                    {
                        var g = Vca(ctx, outp, t, v * noiseL, dur * 0.5);
                        NoiseSrc(ctx, t, dur).Connect(Filt(ctx, "bandpass", noiseFreq * k, 0.9)).Connect(g);
                    }
                };
            }
            case "cowbell":
            {
                double[] freqs = Arr("freqs", new double[] { 540, 800 });
                double bp = D("bp", 2640), q = D("q", 1.2), decay = D("decay", 0.35), level = D("level", 0.45);
                return (ctx, outp, t, v, tune, dm) =>
                {
                    double k = Ratio(tune), dur = decay * dm;
                    var amp = ctx.Gain();
                    var a = amp.GainParam;
                    a.SetValueAtTime(EPS, t);
                    a.ExponentialRampToValueAtTime((float)(v * level), t + 0.001);
                    a.ExponentialRampToValueAtTime((float)(v * level * 0.35), t + 0.03);
                    a.ExponentialRampToValueAtTime(EPS, t + 0.03 + dur);
                    amp.Connect(outp);
                    var f = Filt(ctx, "bandpass", bp * k, q);
                    f.Connect(amp);
                    foreach (var fr in freqs) Osc(ctx, "square", fr * k, t, dur + 0.03).Connect(f);
                };
            }
            case "noiseHit":
            {
                string ft = S("type", "highpass");
                double freq = D("freq", 6000), q = D("q", 0.7), to = D("to", 0), attack = D("attack", 0.001), decay = D("decay", 0.1),
                    level = D("level", 0.6), drive = D("drive", 0);
                return (ctx, outp, t, v, tune, d) =>
                {
                    double k = Ratio(tune);
                    double att = attack > 0.05 ? attack * d : attack, dur = decay * d;
                    var amp = Vca(ctx, outp, t, v * level, dur, att);
                    var f = Filt(ctx, ft, freq * k, q);
                    if (to > 0) f.Frequency.ExponentialRampToValueAtTime((float)Math.Min(to * k, ctx.SampleRate / 2.0 - 100), t + att + dur * 0.8);
                    var src = NoiseSrc(ctx, t, att + dur);
                    if (drive > 0) src.Connect(f).Connect(ctx.Shaper(DriveCurve(drive), 4)).Connect(amp);
                    else src.Connect(f).Connect(amp);
                };
            }
            default:
                return (_, _, _, _, _, _) => { };
        }
    }
}
