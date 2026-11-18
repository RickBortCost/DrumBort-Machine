// Sequencer.cs — Progetto, scheduler look-ahead e modalità di riproduzione: pattern singolo,
// song mode, session (lanci quantizzati, follow action, arrangiamento). Porting di
// js/sequencer.js, js/session.js e della parte di js/ui.js che gestisce session e song.

using System.Text.Json.Nodes;
using DrumBort.Audio;

namespace DrumBort.Engine;

public sealed class Project
{
    public Pattern[] Slots = Enumerable.Range(0, 8).Select(_ => Pattern.Parse(null)).ToArray();
    public int Slot;
    public Fx Fx = new();
    public (int slot, int rep)[] Chain = Array.Empty<(int, int)>();
    public bool SongOn;
    public string? Lock;
    public int Quant = 16;
    public (string a, int n)[] Follow = Enumerable.Range(0, 8).Select(_ => ("none", 4)).ToArray();
    public bool ArrOn;
    public (int[] m, int s)[] Arr = Array.Empty<(int[], int)>();
    public string Mode = "pattern";

    /// <summary>Applica le parti ricevute (stesso formato di remoteParts() nella web app).</summary>
    public void Apply(JsonObject parts)
    {
        if (parts["userPresets"] is JsonArray up) Synth.SetUserPresets(up);
        if (parts["userKits"] is JsonArray uk) Kits.SetUserKits(uk);
        for (int i = 0; i < 8; i++) if (parts[$"p{i}"] is JsonObject p) Slots[i] = Pattern.Parse(p);
        if (parts["slot"] is JsonValue sv && sv.TryGetValue(out double sd)) Slot = Math.Clamp((int)sd, 0, 7);
        if (parts["fx"] is JsonObject fx) Fx = Fx.Parse(fx);
        if (parts["song"] is JsonObject song)
        {
            SongOn = J.B(song, "on");
            Chain = (song["chain"] as JsonArray ?? new JsonArray()).Select(e => (Math.Clamp(J.I(e, "slot", 0), 0, 7), Math.Max(1, J.I(e, "rep", 1)))).ToArray();
        }
        if (parts.ContainsKey("lock")) Lock = J.S(parts, "lock", "") is var l && l != "" ? l : null;
        if (parts["session"] is JsonObject ses)
        {
            Quant = J.I(ses, "quant", 16);
            if (ses["follow"] is JsonArray fa) Follow = Enumerable.Range(0, 8).Select(i => i < fa.Count ? (J.S(fa[i], "a", "none"), J.I(fa[i], "n", 4)) : ("none", 4)).ToArray();
        }
        if (parts["arr"] is JsonObject arr)
        {
            ArrOn = J.B(arr, "on");
            Arr = (arr["bars"] as JsonArray ?? new JsonArray()).Select(b => (J.Nums(b?["m"]).Select(x => (int)x).Concat(Enumerable.Repeat(-1, 12)).Take(12).ToArray(), J.I(b, "s", 0))).ToArray();
        }
        if (parts["mode"] is JsonValue mv && mv.TryGetValue(out string? m)) Mode = m ?? "pattern";
    }

    public KitDef KitOf(Pattern p) => Kits.ById(Lock ?? p.Kit);
}

public sealed class Sequencer
{
    public const int Steps = 16, TracksN = 8;
    static readonly double[] Velocity = { 0, 0.62, 1 };
    const double FlamGap = 0.022, Ahead = 0.06;

    readonly Mixer mx;
    readonly AudioContext ctx;
    public readonly Project P = new();
    readonly Random rnd = new();

    public bool Playing { get; private set; }
    public bool Metronome;
    public Pattern Pattern = Pattern.Parse(null);
    long tick; double nextTime;
    (long from, int len)? stutter;
    public Pattern? FillPattern;
    public HashSet<int> MuteD = new(), MuteS = new();

    // Session
    public readonly int[] Map = Enumerable.Repeat(-1, 12).ToArray();
    public int Master;
    readonly int?[] queued = new int?[12];
    int? pendingMaster, curScene;
    int sceneBars, arrBar;
    // Song
    int songI, songR;
    public long Tick => tick;

    public Sequencer(Mixer m) { mx = m; ctx = m.Ctx; }

    bool Session => P.Mode == "session";

    // =================================================================
    // Pattern e mixer
    // =================================================================
    static readonly int[] EmptyRow = new int[16];
    static readonly StepOpt?[] EmptyOpts = new StepOpt?[16];

    /// <summary>Pattern composto dalle clip della session (riferimenti, nessuna copia).</summary>
    Pattern Compose()
    {
        var b = P.Slots[Master];
        var p = new Pattern { Kit = P.Lock ?? b.Kit, Bpm = b.Bpm, Swing = b.Swing, Human = b.Human, Kits = new KitDef?[8] };
        p.Synth = new SynthSection { Key = b.Synth.Key, Scale = b.Synth.Scale };
        for (int t = 0; t < 8; t++)
        {
            var s = Map[t] >= 0 ? P.Slots[Map[t]] : null;
            p.Steps[t] = s != null ? s.Steps[t] : EmptyRow;
            p.Opts[t] = s != null ? s.Opts[t] : EmptyOpts;
            p.Tracks[t] = (s ?? b).Tracks[t];
            p.Kits[t] = Kits.ById(P.Lock ?? (s ?? b).Kit);
        }
        for (int k = 0; k < 4; k++)
        {
            var s = Map[8 + k] >= 0 ? P.Slots[Map[8 + k]] : null;
            if (s != null) p.Synth.Tracks[k] = s.Synth.Tracks[k];
            else
            {
                var e = (SynthTrack)SynthTrack.Parse(null, k);
                var bt = b.Synth.Tracks[k];
                e.Preset = bt.Preset; e.Patch = bt.Patch; e.Vol = bt.Vol; e.Pan = bt.Pan; e.Rev = bt.Rev; e.Dly = bt.Dly; e.Mute = bt.Mute;
                p.Synth.Tracks[k] = e;
            }
        }
        return p;
    }

    /// <summary>Allinea motore e pattern dopo una modifica del progetto (come syncPlayback()).</summary>
    public void Sync()
    {
        if (Session) Pattern = Compose();
        else if (!(Playing && P.SongOn && P.Chain.Length > 0)) Pattern = P.Slots[P.Slot];
        else Pattern = P.Slots[P.Chain[Math.Min(songI, P.Chain.Length - 1)].slot];
        mx.SetKit(P.KitOf(Pattern));
        mx.ApplyMix(Pattern, ctx.CurrentTime);
        mx.SetFx(P.Fx, Pattern.Bpm);
        Prewarm();
    }

    /// <summary>Pre-render delle voci del pattern in riproduzione e di tutti gli slot (batteria e synth).</summary>
    public void Prewarm()
    {
        mx.Prewarm(Pattern, PrewarmEvent);
        foreach (var p in P.Slots) if (p != Pattern) mx.Prewarm(p, PrewarmEvent);
    }
    static (int[] notes, double dur, double vel, int? glide, SynthTrack tr)? PrewarmEvent(Pattern p, int k, int s) =>
        SynthEvent(p, k, s) is var (n, d, v, g, t) ? (n, d, v, g, t) : null;

    // =================================================================
    // Trasporto
    // =================================================================
    public void Start()
    {
        if (Playing) return;
        if (Session)
        {
            sceneBars = 0;
            if (P.ArrOn && P.Arr.Length > 0) { Array.Fill(queued, null); pendingMaster = null; arrBar = 0; LoadArrBar(0); }
            else
            {
                arrBar = 0;
                ApplyQueued();
                if (Map.All(v => v < 0)) { Array.Fill(Map, P.Slot); Master = P.Slot; }
            }
        }
        else if (P.SongOn && P.Chain.Length > 0) { songI = 0; songR = 0; }
        Playing = true;
        tick = 0;
        nextTime = ctx.CurrentTime + 0.03;
        Sync();
    }

    public void Stop()
    {
        Playing = false;
        Array.Fill(queued, null);
        pendingMaster = null;
        stutter = null;
    }

    // =================================================================
    // Session: lanci, scene, follow action, arrangiamento
    // =================================================================
    bool ApplyQueued()
    {
        bool changed = false;
        for (int i = 0; i < 12; i++) if (queued[i] is int q) { Map[i] = q; queued[i] = null; changed = true; }
        if (pendingMaster is int pm) { Master = pm; curScene = pm; pendingMaster = null; sceneBars = 0; changed = true; }
        return changed;
    }
    bool HasQueued => pendingMaster != null || queued.Any(q => q != null);
    void LeaveArr() { if (P.ArrOn && Playing) P.ArrOn = false; }

    public void LaunchClip(int i, int slot)
    {
        if (i < 0 || i >= 12) return;
        LeaveArr();
        if (!Playing)
        {
            Map[i] = slot;
            if (slot >= 0 && Map.Count(v => v >= 0) == 1) Master = slot;
            if (slot >= 0) Start(); else Sync();
        }
        else queued[i] = slot;
    }

    public void LaunchScene(int slot)
    {
        LeaveArr();
        if (!Playing) { Array.Fill(Map, slot); Master = slot; curScene = slot; sceneBars = 0; Start(); }
        else { for (int i = 0; i < 12; i++) queued[i] = slot; pendingMaster = slot; }
    }

    public void StopAllClips()
    {
        LeaveArr();
        curScene = null; pendingMaster = null;
        if (!Playing) Array.Fill(Map, -1); else for (int i = 0; i < 12; i++) queued[i] = -1;
    }

    public void ToggleArr()
    {
        if (P.Arr.Length == 0) return;
        P.ArrOn = !P.ArrOn;
        if (P.ArrOn) { Array.Fill(queued, null); pendingMaster = null; }
    }

    void LoadArrBar(int b)
    {
        if (b < 0 || b >= P.Arr.Length) return;
        var (m, s) = P.Arr[b];
        Array.Copy(m, Map, 12);
        Master = Math.Clamp(s, 0, 7);
    }

    /// <summary>Scena successiva secondo la follow action (stesso calcolo deterministico della web app).</summary>
    int? FollowTarget(string action, int cur, long t)
    {
        var used = Enumerable.Range(0, 8).Where(s => HasAny(P.Slots[s])).ToList();
        if (used.Count == 0) used.Add(cur);
        int idx = used.IndexOf(cur);
        double r = (uint)((t + 1) * 2654435761L) % 1000 / 1000.0;
        switch (action)
        {
            case "next": return used[(idx + 1) % used.Count];
            case "prev": return used[(idx - 1 + used.Count) % used.Count];
            case "first": return used[0];
            case "rand": return used[(int)(r * used.Count)];
            case "other": { var o = used.Where(s => s != cur).ToList(); return o.Count > 0 ? o[(int)(r * o.Count)] : cur; }
            case "stop": return -1;
            default: return null;
        }
    }

    static bool HasAny(Pattern p)
    {
        for (int t = 0; t < 8; t++) if (p.Steps[t].Any(v => v > 0)) return true;
        return p.Synth.Tracks.Any(t => t.Steps.Any(s => s != null) || t.Arp.On);
    }

    Pattern? OnStep(long t, double time)
    {
        if (!Session) return null;
        bool changed = false, bar = t > 0 && t % Steps == 0;
        if (bar)
        {
            int len = P.Arr.Length;
            arrBar = len > 0 ? (arrBar + 1) % len : 0;
            if (P.ArrOn && len > 0) { LoadArrBar(arrBar); changed = true; }
            else
            {
                sceneBars++;
                if (curScene is int sc)
                {
                    var (a, n) = P.Follow[sc];
                    if (a != "none" && sceneBars >= n && !HasQueued)
                    {
                        var tg = FollowTarget(a, sc, t);
                        if (tg == -1) { for (int i = 0; i < 12; i++) queued[i] = -1; curScene = null; }
                        else if (tg is int x) { for (int i = 0; i < 12; i++) queued[i] = x; pendingMaster = x; }
                        changed = ApplyQueued() || changed;
                        sceneBars = 0;
                    }
                }
            }
        }
        if (HasQueued && t % Math.Max(1, P.Quant) == 0) changed = ApplyQueued() || changed;
        if (!changed) return null;
        var next = Compose();
        mx.Kit = Kits.ById(next.Kit);
        mx.ApplyMix(next, time);
        mx.SetFx(P.Fx, next.Bpm);
        mx.SetChainKit(Kits.ById(next.Kit));
        return next;
    }

    Pattern? OnBar(long t, double time)
    {
        if (Session || !P.SongOn || P.Chain.Length == 0) return null;
        songR++;
        if (songI >= P.Chain.Length) songI = 0;
        if (songR >= P.Chain[songI].rep) { songI = (songI + 1) % P.Chain.Length; songR = 0; }
        var next = P.Slots[P.Chain[songI].slot];
        mx.Kit = P.KitOf(next);
        mx.ApplyMix(next, time);
        mx.SetFx(P.Fx, next.Bpm);
        mx.SetChainKit(P.KitOf(next));
        return next;
    }

    // =================================================================
    // Scheduler (chiamato a ogni blocco dal thread audio)
    // =================================================================
    static double StepDur(int bpm) => 60.0 / bpm / 4;
    static double SwingOffset(long t, int swing, double sd) => t % 2 == 1 ? (swing / 100.0 - 0.5) * 2 * sd : 0;

    public void Run()
    {
        if (!Playing) return;
        double now = ctx.CurrentTime;
        if (nextTime < now - 0.2) nextTime = now + 0.02;
        while (nextTime < now + Ahead)
        {
            if (tick > 0 && tick % Steps == 0 && OnBar(tick, nextTime) is Pattern nb) Pattern = nb;
            if (OnStep(tick, nextTime) is Pattern ns) Pattern = ns;
            double sd = StepDur(Pattern.Bpm);
            double time = nextTime + SwingOffset(tick, Pattern.Swing, sd);
            long pt = stutter is var (from, len) ? from + (tick - from) % len : tick;
            ScheduleTick(FillPattern ?? Pattern, pt, time);
            if (Metronome && tick % 4 == 0) mx.Click(time, tick % Steps == 0);
            nextTime += sd;
            tick++;
        }
    }

    public void StartStutter(int len) { if (len > 0) stutter = (tick, len); else stutter = null; }
    public void Fill(bool on) => FillPattern = on ? MakeFill(Pattern) : null;

    static Pattern MakeFill(Pattern src)
    {
        var f = src.Clone();
        f.Steps = src.Steps.Select(r => (int[])r.Clone()).ToArray();
        f.Opts = src.Opts.Select(r => (StepOpt?[])r.Clone()).ToArray();
        f.Tracks = src.Tracks.Select(t => t.With(null)).ToArray();
        void Set(int t, int s, int v) => f.Steps[t][s] = v;
        for (int s = 0; s < 16; s++)
        {
            Set(2, s, 0); Set(3, s, 0); Set(4, s, 0);
            Set(1, s, s >= 8 ? (s >= 12 ? 2 : 1) : (s % 2 == 1 ? 1 : 0));
            Set(5, s, new[] { 2, 3, 6, 7, 10, 11 }.Contains(s) ? 1 : 0);
        }
        Set(0, 0, 2); Set(0, 8, 1); Set(6, 0, 2);
        f.Opts[1][14] = new StepOpt { R = 2 };
        f.Opts[1][15] = new StepOpt { R = 3 };
        f.Tracks = f.Tracks.Select(t => new DrumTrack { Vol = t.Vol, Tune = t.Tune, Decay = t.Decay, Pan = t.Pan, Rev = t.Rev, Dly = t.Dly, Drv = t.Drv, Crush = t.Crush, Mute = t.Mute, Solo = t.Solo, Len = 16 }).ToArray();
        return f;
    }

    void ScheduleTick(Pattern pat, long t, double time)
    {
        double sd = StepDur(pat.Bpm), human = pat.Human;
        bool anySolo = pat.Tracks.Any(x => x.Solo);
        for (int tr = 0; tr < TracksN; tr++)
        {
            var track = pat.Tracks[tr];
            int s = (int)(t % Math.Max(1, track.Len));
            int v = pat.Steps[tr][s];
            if (v == 0) continue;
            if (anySolo ? !track.Solo : track.Mute) continue;
            if (MuteD.Contains(tr)) continue;
            var o = pat.Opts[tr][s];
            if (o != null && o.P < 100 && rnd.NextDouble() * 100 >= o.P) continue;
            double tt = time + (o != null ? o.N / 100.0 * sd : 0);
            double vel = o?.Vel ?? Velocity[v];
            if (human > 0) { tt += (rnd.NextDouble() - 0.5) * 0.02 * human; vel *= 1 - rnd.NextDouble() * 0.3 * human; }
            var pp = track.With(o);
            var kit = pat.Kits?[tr];
            if (o != null && o.F) { mx.Trigger(tr, tt, vel * 0.45, pp, kit); tt += FlamGap; }
            int r = o?.R ?? 1;
            for (int k = 0; k < r; k++) mx.Trigger(tr, tt + k * sd / r, k > 0 ? vel * 0.8 : vel, pp, kit);
        }

        var syn = pat.Synth;
        bool anySynthSolo = syn.Tracks.Any(x => x.Solo);
        for (int k = 0; k < 4; k++)
        {
            var tr = syn.Tracks[k];
            if (anySynthSolo ? !tr.Solo : tr.Mute) continue;
            if (MuteS.Contains(k)) continue;
            double tj = human > 0 ? time + (rnd.NextDouble() - 0.5) * 0.01 * human : time;
            if (tr.Arp.On)
            {
                foreach (var e in ArpEvents(pat, k, t)) mx.PlaySynth(k, tj + e.offset, e.dur, e.notes, e.vel, tr);
                continue;
            }
            int s = (int)(t % Math.Max(1, tr.Len));
            if (tr.Steps[s] == null) continue;
            var ev = SynthEvent(pat, k, s)!.Value;
            mx.PlaySynth(k, tj, ev.dur, ev.notes, ev.vel, ev.track, ev.glideFrom);
        }
    }

    static (int[] notes, double dur, double vel, int? glideFrom, SynthTrack track)? SynthEvent(Pattern pat, int k, int s)
    {
        var tr = pat.Synth.Tracks[k];
        int len = Math.Max(1, tr.Len);
        var st = tr.Steps[s];
        if (st == null) return null;
        var prev = tr.Steps[(s - 1 + len) % len];
        int? glideFrom = k < 2 && prev != null && prev.Sl && len > 1 ? prev.N : null;
        int[] notes = st.Ch != null ? st.Ch.Select(x => st.N + x).ToArray() : new[] { st.N };
        double dur = st.G * StepDur(pat.Bpm) * (st.Sl ? 1.15 : 0.92);
        double vel = st.Vel ?? (st.A ? 1 : 0.7);
        return (notes, dur, vel, glideFrom, tr.With(st));
    }

    static int TrackBase(SynthSection syn, int k) => 12 * (SynthDefs.Tracks[k].Oct + syn.Tracks[k].Oct + 1) + syn.Key;

    static List<int>? ArpChord(Pattern pat, int k, long t)
    {
        var syn = pat.Synth; var arp = syn.Tracks[k].Arp;
        if (arp.Src == k) return null;
        var src = syn.Tracks[arp.Src];
        int len = Math.Max(1, src.Len), s = (int)(t % len);
        SynthStep? chord = null;
        for (int d = 0; d < len; d++)
        {
            var st = src.Steps[(s - d + len) % len];
            if (st != null) { if (st.G > d) chord = st; break; }
        }
        if (chord == null) return null;
        var notes = (chord.Ch ?? new[] { 0 }).Select(x => chord.N + x).OrderBy(x => x).ToList();
        int shift = 12 * (int)Math.Floor((TrackBase(syn, k) - notes[0]) / 12.0 + 0.5);   // come Math.round in JS
        var outp = new List<int>();
        for (int o = 0; o < arp.Oct; o++) foreach (var n in notes) outp.Add(n + shift + 12 * o);
        return outp;
    }

    static int ArpPick(List<int> seq, long i, string mode)
    {
        int L = seq.Count;
        if (L == 1) return seq[0];
        switch (mode)
        {
            case "down": return seq[L - 1 - (int)(i % L)];
            case "updown": { int p = 2 * L - 2; int j = (int)(i % p); return seq[j < L ? j : p - j]; }
            case "random": { uint h = (uint)((i + 1) * 2654435761L); return seq[(int)(h % (uint)L)]; }
            default: return seq[(int)(i % L)];
        }
    }

    static List<(double offset, int[] notes, double dur, double vel)> ArpEvents(Pattern pat, int k, long t)
    {
        var res = new List<(double, int[], double, double)>();
        var arp = pat.Synth.Tracks[k].Arp;
        var seq = ArpChord(pat, k, t);
        if (seq == null) return res;
        double sd = StepDur(pat.Bpm), rate = arp.Rate;
        if (rate >= 1 && t % (long)rate != 0) return res;
        int per = rate < 1 ? (int)Math.Round(1 / rate) : 1;
        for (int j = 0; j < per; j++)
        {
            long idx = rate < 1 ? t * per + j : (long)Math.Floor(t / rate);
            res.Add((j * sd * rate, new[] { ArpPick(seq, idx, arp.Mode) }, sd * rate * arp.Gate, idx % seq.Count == 0 ? 0.85 : 0.7));
        }
        return res;
    }
}
