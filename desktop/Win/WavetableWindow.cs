// WavetableWindow.cs — Editor del synth wavetable in una finestra a parte (non modale: la finestra
// principale resta utilizzabile). Struttura ispirata ai synth wavetable come Massive:
//   3 oscillatori wavetable con posizione (morph) · oscillatore di modulazione (ring e phase mod per
//   oscillatore) · rumore e unisono · 2 filtri in serie o parallelo con mix · drive · inviluppo
//   d'ampiezza + 3 inviluppi di modulazione · 4 LFO · stepper a 16 passi · 8 macro ·
//   matrice di modulazione a 16 slot.
// La patch è quella della web app (track.patch = { name, a, d, s, r, glide, gain, wt: {...} }), quindi
// suona uguale nel motore C#, nei telefoni collegati e nella web app.

using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using DrumBort.Engine;

namespace DrumBort.Win;

public sealed class WavetableWindow : Window
{
    static WavetableWindow? current;
    readonly Doc doc;
    int ch;                       // traccia synth (8-11)
    JsonObject P = Init();        // patch in modifica
    bool linked;                  // la traccia usa questa patch: ogni modifica suona subito
    readonly StackPanel body = new() { Margin = new Thickness(10) };
    readonly TextBlock status = Txt.Make("", 11, Theme.Dim);
    static readonly string[] Tables = { "analog", "sync", "formant", "digital", "harmonic", "growl", "fm" };
    static readonly Dictionary<string, string> TableName = new() { ["analog"] = "Analog", ["sync"] = "Sync", ["formant"] = "Vocal", ["digital"] = "Digital", ["harmonic"] = "Additive", ["growl"] = "Growl", ["fm"] = "FM" };
    static readonly string[] Filters = { "lowpass", "bandpass", "highpass", "notch" };
    static readonly Dictionary<string, string> FilterName = new() { ["none"] = "Off", ["lowpass"] = "Passa-basso", ["bandpass"] = "Passa-banda", ["highpass"] = "Passa-alto", ["notch"] = "Notch" };
    static readonly string[] Sources = { "env2", "env3", "env4", "lfo1", "lfo2", "lfo3", "lfo4", "step", "vel", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8" };
    string SourceName(string s) => s switch
    {
        "env2" => "Env 2", "env3" => "Env 3", "env4" => "Env 4", "lfo1" => "LFO 1", "lfo2" => "LFO 2", "lfo3" => "LFO 3", "lfo4" => "LFO 4",
        "step" => "Stepper", "vel" => "Velocity",
        _ => (W["macroNames"] as JsonArray)?[int.Parse(s[1..]) - 1]?.ToString() ?? $"Macro {s[1..]}",
    };
    static readonly string[] Dests = { "pos", "pos1", "pos2", "pos3", "cut", "cut1", "cut2", "pitch", "amp", "res", "pm", "noise" };
    static readonly Dictionary<string, string> DestName = new() { ["pos"] = "WT pos (tutti)", ["pos1"] = "WT pos 1", ["pos2"] = "WT pos 2", ["pos3"] = "WT pos 3", ["cut"] = "Cutoff (tutti)", ["cut1"] = "Cutoff 1", ["cut2"] = "Cutoff 2", ["pitch"] = "Intonazione", ["amp"] = "Volume", ["res"] = "Risonanza", ["pm"] = "Phase mod", ["noise"] = "Rumore" };
    const int ModSlots = 16;
    static readonly string[] Shapes = { "sine", "triangle", "sawtooth", "square" };
    static readonly double[] Syncs = { 0, 0.25, 0.5, 1, 2, 4 };

    /// <summary>Apre l'editor sulla traccia synth `ch` (o porta in primo piano quello già aperto).</summary>
    public static void Open(Window owner, Doc doc, int ch, bool applyNow = false)
    {
        if (current == null) { current = new WavetableWindow(doc) { Owner = owner }; current.Show(); }
        current.Target(ch);
        if (applyNow) current.Apply();
        current.Activate();
    }
    public static WavetableWindow? Current => current;

    WavetableWindow(Doc doc)
    {
        this.doc = doc;
        Title = "Wavetable Synth";
        Width = 1240; Height = 820; MinWidth = 900; MinHeight = 600;
        Background = Theme.Bg; Foreground = Theme.Ink; FontFamily = Theme.Font;
        ShowInTaskbar = true;
        Content = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto };
        Closed += (_, _) => current = null;
        doc.Changed += OnDocChanged;
        Closed += (_, _) => doc.Changed -= OnDocChanged;
        KeyDown += (_, e) => { if (e.Key == Key.Space && Keyboard.FocusedElement is not TextBox) { Preview(); e.Handled = true; } };
    }

    void OnDocChanged()
    {
        // Annulla, file aperto o modifica da un telefono: si rilegge la patch della traccia
        if (!IsLoaded) return;
        var t = Doc.TrackOf(doc.Pat, ch);
        if (linked && t["patch"] is JsonObject tp && tp["wt"] is JsonObject && tp.ToJsonString() != P.ToJsonString()) { P = Normalize((JsonObject)tp.DeepClone()); Render(); }
        else if (linked && t["patch"] is not JsonObject) { linked = false; Render(); }
    }

    // ------------------------------------------------------------------ patch
    static JsonObject Osc(string table, int semi, double level) => new() { ["table"] = table, ["pos"] = 0, ["semi"] = semi, ["fine"] = 0, ["level"] = level };
    static JsonObject Init() => new()
    {
        ["name"] = "Init Wavetable", ["cat"] = "Wavetable", ["tags"] = new JsonArray("wavetable"),
        ["a"] = 0.005, ["d"] = 0.5, ["s"] = 0.8, ["r"] = 0.3, ["glide"] = 0, ["gain"] = 1, ["rev"] = 0,
        ["wt"] = new JsonObject
        {
            ["osc"] = new JsonArray(Osc("analog", 0, 1), Osc("analog", 0, 0), Osc("analog", -12, 0)),
            ["uni"] = new JsonObject { ["voices"] = 1, ["detune"] = 12 },
            ["noise"] = 0,
            ["f1"] = new JsonObject { ["type"] = "lowpass", ["cut"] = 3000, ["res"] = 1 },
            ["f2"] = new JsonObject { ["type"] = "none", ["cut"] = 1200, ["res"] = 1 },
            ["route"] = "serial", ["mix"] = 0.5, ["drive"] = 0,
            ["env2"] = new JsonObject { ["a"] = 0.01, ["d"] = 0.4, ["s"] = 0, ["r"] = 0.3 },
            ["env3"] = new JsonObject { ["a"] = 0.3, ["d"] = 0.8, ["s"] = 0.5, ["r"] = 0.6 },
            ["env4"] = new JsonObject { ["a"] = 1.5, ["d"] = 2, ["s"] = 1, ["r"] = 1.5 },
            ["lfo1"] = new JsonObject { ["shape"] = "sine", ["rate"] = 2, ["sync"] = 0 },
            ["lfo2"] = new JsonObject { ["shape"] = "triangle", ["rate"] = 0.3, ["sync"] = 0 },
            ["lfo3"] = new JsonObject { ["shape"] = "sawtooth", ["rate"] = 4, ["sync"] = 0 },
            ["lfo4"] = new JsonObject { ["shape"] = "square", ["rate"] = 0.5, ["sync"] = 0 },
            ["modosc"] = new JsonObject { ["shape"] = "sine", ["semi"] = 0, ["fine"] = 0, ["rm"] = new JsonArray(0, 0, 0), ["pm"] = new JsonArray(0, 0, 0) },
            ["macros"] = new JsonArray(0, 0, 0, 0, 0, 0, 0, 0),
            ["macroNames"] = new JsonArray(Enumerable.Range(1, 8).Select(i => (JsonNode)$"Macro {i}").ToArray()),
            ["step"] = new JsonObject { ["values"] = new JsonArray(1, 0, 0.6, 0, 1, 0, 0.6, 0.3, 1, 0, 0.6, 0, 1, 0.3, 0.6, 0), ["div"] = 1 },
            ["mod"] = new JsonArray(),
        },
    };
    JsonObject W => (JsonObject)P["wt"]!;

    static List<(string id, JsonObject p)>? presets;
    static List<(string id, JsonObject p)> Presets()
    {
        if (presets != null) return presets;
        var o = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Assets", "presets.json")))!.AsObject();
        return presets = o.Where(kv => kv.Value?["wt"] is JsonObject).Select(kv => (kv.Key, (JsonObject)kv.Value!)).ToList();
    }

    void Target(int c)
    {
        ch = Math.Clamp(c, 8, 11);
        var t = Doc.TrackOf(doc.Pat, ch);
        linked = doc.Tracks.Contains(ch) && t["patch"] is JsonObject p && p["wt"] is JsonObject;
        if (linked) P = Normalize((JsonObject)t["patch"]!.DeepClone());
        else if (Synth.Presets.ContainsKey(Doc.Str(t, "preset", "")) && Presets().FirstOrDefault(x => x.id == Doc.Str(t, "preset", "")) is var (pid, pp) && pid != null) P = Normalize((JsonObject)pp.DeepClone());
        Render();
    }

    /// <summary>Completa una patch (preset) con i campi mancanti della patch iniziale.</summary>
    static JsonObject Normalize(JsonObject p)
    {
        var init = Init();
        foreach (var (k, v) in init) if (p[k] == null) p[k] = v?.DeepClone();
        var w = (JsonObject)p["wt"]!;
        foreach (var (k, v) in (JsonObject)init["wt"]!) if (w[k] == null) w[k] = v?.DeepClone();
        return p;
    }

    /// <summary>Patch alla traccia (in tutti i pattern), traccia attivata se era vuota.</summary>
    void Apply()
    {
        doc.Snapshot();
        if (!doc.Tracks.Contains(ch)) { doc.SetTracks(doc.Tracks.Append(ch)); doc.SetAll(ch, "mute", false); }
        doc.SetAll(ch, "patch", P);
        linked = true;
        doc.Commit(doc.AllPatKeys.Append("tracks").ToArray());
        Render();
    }

    /// <summary>Modifica di un parametro: se la traccia usa questa patch, suona subito.</summary>
    void Push(bool redraw = false)
    {
        if (linked) { doc.SetAll(ch, "patch", P); doc.CommitQuiet(doc.AllPatKeys); }
        if (redraw) Render();
    }
    void Begin() { if (linked) doc.Snapshot(); }
    void End() { if (linked) doc.Commit(doc.AllPatKeys); }

    void Preview()
    {
        if (!linked) { status.Text = "Applica la patch a una traccia per ascoltarla."; return; }
        doc.PreviewSynth(ch - 8, doc.Base(ch - 8));
    }

    // ------------------------------------------------------------------ interfaccia
    static Border Panel(string title, Brush accent, UIElement content, double width = double.NaN)
    {
        var sp = new StackPanel();
        var h = Txt.Make(title, 11, accent, true); h.Margin = new Thickness(8, 5, 8, 3);
        sp.Children.Add(h);
        sp.Children.Add(content);
        return new Border { Background = Theme.Panel, BorderBrush = accent, BorderThickness = new Thickness(0, 3, 0, 0), CornerRadius = new CornerRadius(4), Margin = new Thickness(0, 0, 8, 8), Child = sp, Width = width, VerticalAlignment = VerticalAlignment.Top };
    }
    static WrapPanel Row() => new() { Margin = new Thickness(6, 0, 6, 6) };

    Knob K(string label, double min, double max, double def, Func<double> get, Action<double> set, Func<double, string> fmt, bool log = false, bool integer = false, Brush? col = null)
    {
        var k = new Knob(label, min, max, def, get(), fmt, log) { Color = col ?? Theme.Orange, Integer = integer };
        k.Begin += Begin;
        k.Changed += v => { set(v); Push(); };
        k.End += End;
        return k;
    }
    Dropdown D(double w, IEnumerable<(string, string)> items, string value, Action<string> set)
    {
        var d = new Dropdown(w) { Margin = new Thickness(2, 4, 2, 4) };
        d.SetItems(items);
        d.Value = value;
        d.Changed += v => { Begin(); set(v); Push(true); End(); };
        return d;
    }
    static double N(JsonNode? n, string k, double def) => Doc.Num(n, k, def);
    static string F(double v, string f) => v.ToString(f, CultureInfo.InvariantCulture);
    static string Hz(double v) => v >= 1000 ? F(v / 1000, "0.0") + " k" : F(v, "0") + " Hz";
    static string Sec(double v) => v < 1 ? F(v * 1000, "0") + " ms" : F(v, "0.00") + " s";
    static string Pct(double v) => F(v * 100, "0") + " %";

    void Render()
    {
        body.Children.Clear();
        var orange = Theme.Orange; var cyan = Theme.Cyan; var green = Theme.Green; var purple = Theme.Track(10);

        // --- barra in alto: preset, traccia, applica, ascolta
        var top = new WrapPanel { Margin = new Thickness(0, 0, 0, 8) };
        var title = Txt.Make("WAVETABLE SYNTH", 18, orange, true); title.Margin = new Thickness(0, 0, 16, 0); title.VerticalAlignment = VerticalAlignment.Center;
        top.Children.Add(title);
        var name = new TextBox { Text = Doc.Str(P, "name", "Wavetable"), Width = 170, FontSize = 13, Background = Theme.Dark, Foreground = Theme.Lcd, BorderBrush = Theme.Edge, Padding = new Thickness(4, 2, 4, 2), VerticalAlignment = VerticalAlignment.Center, ToolTip = "Nome della patch" };
        name.LostFocus += (_, _) => { if (name.Text.Trim() != "" && name.Text.Trim() != Doc.Str(P, "name", "")) { Begin(); P["name"] = name.Text.Trim(); Push(); End(); } };
        top.Children.Add(name);
        top.Children.Add(D(170, new[] { ("", "Preset…") }.Concat(Presets().Select(x => (x.id, Doc.Str(x.p, "name", x.id)))).Append(("init", "— Init —")), "", v =>
        {
            if (v == "") return;
            P = v == "init" ? Init() : Normalize((JsonObject)Presets().First(x => x.id == v).p.DeepClone());
        }));
        top.Children.Add(new Border { Width = 16 });
        top.Children.Add(Txt.Make("TRACCIA", 10, Theme.Dim));
        var tr = new Dropdown(150) { Margin = new Thickness(4), ToolTip = "Traccia synth che usa questa patch (le tracce vuote diventano attive con APPLICA)" };
        tr.SetItems(Enumerable.Range(8, 4).Select(c => (c.ToString(), $"{Doc.SynthShort[c - 8]} · {Doc.SynthNames[c - 8]}" + (!doc.Tracks.Contains(c) ? " (vuota)" : Doc.TrackOf(doc.Pat, c)["patch"] is JsonObject tp && tp["wt"] != null ? " · WT" : ""))));
        tr.Value = ch.ToString();
        tr.Changed += v => Target(int.Parse(v));
        top.Children.Add(tr);
        var apply = new Btn(linked ? "✓ COLLEGATA" : "APPLICA ALLA TRACCIA", 0, linked ? "La traccia usa questa patch: ogni modifica si sente subito" : "Usa questa patch come strumento della traccia (anche se vuota)") { IsOn = !linked, Fg = linked ? Theme.Green : Theme.Ink };
        apply.Click += () => { if (!linked) Apply(); };
        top.Children.Add(apply);
        var play = new Btn("▶ ASCOLTA", 0, "Suona la tonica (Spazio)");
        play.Click += Preview;
        top.Children.Add(play);
        (status.Parent as Panel)?.Children.Remove(status);
        status.Margin = new Thickness(10, 0, 0, 0); status.VerticalAlignment = VerticalAlignment.Center;
        status.Text = linked ? $"Modifiche dal vivo su {doc.TrackShort(ch)}. La finestra principale resta utilizzabile." : "Anteprima della patch: APPLICA per usarla come strumento della traccia.";
        top.Children.Add(status);
        body.Children.Add(top);

        // --- oscillatori, rumore e unisono
        var oscRow = new WrapPanel();
        var oscs = (JsonArray)W["osc"]!;
        for (int i = 0; i < 3; i++)
        {
            var o = (JsonObject)oscs[i]!;
            var sp = new StackPanel();
            var head = Row();
            head.Children.Add(D(110, Tables.Select(t => (t, TableName[t])), Doc.Str(o, "table", "analog"), v => o["table"] = v));
            sp.Children.Add(head);
            var disp = new WaveDisplay { Table = Doc.Str(o, "table", "analog"), Pos = N(o, "pos", 0), Color = orange, Height = 80, Margin = new Thickness(8, 0, 8, 4) };
            sp.Children.Add(disp);
            var r = Row();
            var pos = K("WT-POS", 0, 1, 0, () => N(o, "pos", 0), v => { o["pos"] = v; disp.Pos = v; disp.InvalidateVisual(); }, Pct);
            r.Children.Add(pos);
            r.Children.Add(K("PITCH", -36, 36, 0, () => N(o, "semi", 0), v => o["semi"] = (int)Math.Round(v), v => F(v, "+0;-0;0") + " st", integer: true));
            r.Children.Add(K("FINE", -100, 100, 0, () => N(o, "fine", 0), v => o["fine"] = Math.Round(v), v => F(v, "+0;-0;0") + " ct", integer: true));
            r.Children.Add(K("AMP", 0, 1, i == 0 ? 1 : 0, () => N(o, "level", 0), v => o["level"] = v, Pct));
            sp.Children.Add(r);
            oscRow.Children.Add(Panel($"OSC {i + 1}", orange, sp, 290));
        }
        var nz = Row();
        nz.Children.Add(K("NOISE", 0, 1, 0, () => N(W, "noise", 0), v => W["noise"] = v, Pct, col: cyan));
        var uni = (JsonObject)W["uni"]!;
        nz.Children.Add(K("VOCI", 1, 3, 1, () => N(uni, "voices", 1), v => uni["voices"] = (int)Math.Round(v), v => F(v, "0"), integer: true, col: cyan));
        nz.Children.Add(K("DETUNE", 0, 60, 12, () => N(uni, "detune", 12), v => uni["detune"] = Math.Round(v), v => F(v, "0") + " ct", col: cyan));
        oscRow.Children.Add(Panel("NOISE · UNISONO", cyan, nz, 220));
        var mo = (JsonObject)W["modosc"]!;
        var moSp = new StackPanel();
        var moH = Row();
        moH.Children.Add(D(100, Shapes.Select(s => (s, s switch { "sine" => "Sinusoide", "triangle" => "Triangolo", "sawtooth" => "Dente sega", _ => "Quadra" })), Doc.Str(mo, "shape", "sine"), v => mo["shape"] = v));
        moSp.Children.Add(moH);
        var moK = Row();
        moK.Children.Add(K("PITCH", -36, 36, 0, () => N(mo, "semi", 0), v => mo["semi"] = (int)Math.Round(v), v => F(v, "+0;-0;0") + " st", integer: true, col: Theme.Red));
        moK.Children.Add(K("FINE", -100, 100, 0, () => N(mo, "fine", 0), v => mo["fine"] = Math.Round(v), v => F(v, "+0;-0;0") + " ct", integer: true, col: Theme.Red));
        moSp.Children.Add(moK);
        var rmRow = Row(); var pmRow = Row();
        var rm = (JsonArray)mo["rm"]!; var pm = (JsonArray)mo["pm"]!;
        for (int i = 0; i < 3; i++)
        {
            int ii = i;
            rmRow.Children.Add(K($"RING {i + 1}", 0, 1, 0, () => Doc.Val(rm[ii]), v => rm[ii] = v, Pct, col: Theme.Red));
            pmRow.Children.Add(K($"PHASE {i + 1}", 0, 1, 0, () => Doc.Val(pm[ii]), v => pm[ii] = v, Pct, col: Theme.Red));
        }
        moSp.Children.Add(rmRow); moSp.Children.Add(pmRow);
        oscRow.Children.Add(Panel("MOD OSC · ring e phase mod sugli oscillatori", Theme.Red, moSp, 290));
        body.Children.Add(oscRow);

        // --- filtri, routing, insert, ampiezza
        var fRow = new WrapPanel();
        UIElement Filter(string key, bool allowNone)
        {
            var f = (JsonObject)W[key]!;
            var sp = new StackPanel();
            var h = Row();
            h.Children.Add(D(120, (allowNone ? new[] { "none" } : Array.Empty<string>()).Concat(Filters).Select(t => (t, FilterName[t])), Doc.Str(f, "type", "lowpass"), v => f["type"] = v));
            sp.Children.Add(h);
            var r = Row();
            r.Children.Add(K("CUTOFF", 30, 18000, 3000, () => N(f, "cut", 3000), v => f["cut"] = Math.Round(v), Hz, log: true, col: green));
            r.Children.Add(K("RESO", 0.3, 25, 1, () => N(f, "res", 1), v => f["res"] = v, v => F(v, "0.0"), log: true, col: green));
            sp.Children.Add(r);
            return sp;
        }
        fRow.Children.Add(Panel("FILTER 1", green, Filter("f1", false), 170));
        var route = new StackPanel();
        var rb = Row();
        foreach (var (id, l) in new[] { ("serial", "SERIE"), ("parallel", "PARALLELO") })
        {
            var b = new Btn(l) { IsOn = Doc.Str(W, "route", "serial") == id, Padding = new Thickness(6, 2, 6, 2) };
            b.Click += () => { Begin(); W["route"] = id; Push(true); End(); };
            rb.Children.Add(b);
        }
        route.Children.Add(rb);
        var rk = Row();
        rk.Children.Add(K("MIX F1↔F2", 0, 1, 0.5, () => N(W, "mix", 0.5), v => W["mix"] = v, v => $"{F((1 - v) * 100, "0")}/{F(v * 100, "0")}", col: green));
        route.Children.Add(rk);
        fRow.Children.Add(Panel("ROUTING", green, route, 180));
        fRow.Children.Add(Panel("FILTER 2", green, Filter("f2", true), 170));
        var ins = Row();
        ins.Children.Add(K("DRIVE", 0, 1, 0, () => N(W, "drive", 0), v => W["drive"] = v, Pct, col: Theme.Red));
        fRow.Children.Add(Panel("INSERT", Theme.Red, ins, 90));
        var amp = Row();
        amp.Children.Add(K("ATTACK", 0.001, 8, 0.005, () => N(P, "a", 0.005), v => P["a"] = v, Sec, log: true));
        amp.Children.Add(K("DECAY", 0.01, 8, 0.5, () => N(P, "d", 0.5), v => P["d"] = v, Sec, log: true));
        amp.Children.Add(K("SUSTAIN", 0, 1, 0.8, () => N(P, "s", 0.8), v => P["s"] = v, Pct));
        amp.Children.Add(K("RELEASE", 0.01, 8, 0.3, () => N(P, "r", 0.3), v => P["r"] = v, Sec, log: true));
        amp.Children.Add(K("GLIDE", 0, 1, 0, () => N(P, "glide", 0), v => P["glide"] = v, v => F(v, "0.00") + " s"));
        amp.Children.Add(K("GAIN", 0.1, 4, 1, () => N(P, "gain", 1), v => P["gain"] = v, v => "×" + F(v, "0.00"), log: true));
        fRow.Children.Add(Panel("AMP · INVILUPPO", orange, amp));
        body.Children.Add(fRow);

        // --- modulatori: inviluppo, LFO, stepper, matrice
        var mRow = new WrapPanel();
        foreach (var ek in new[] { "env2", "env3", "env4" })
        {
            var e = (JsonObject)W[ek]!;
            var env = Row();
            env.Children.Add(K("A", 0.001, 8, 0.01, () => N(e, "a", 0.01), v => e["a"] = v, Sec, log: true, col: purple));
            env.Children.Add(K("D", 0.01, 8, 0.4, () => N(e, "d", 0.4), v => e["d"] = v, Sec, log: true, col: purple));
            env.Children.Add(K("S", 0, 1, 0, () => N(e, "s", 0), v => e["s"] = v, Pct, col: purple));
            env.Children.Add(K("R", 0.01, 8, 0.3, () => N(e, "r", 0.3), v => e["r"] = v, Sec, log: true, col: purple));
            mRow.Children.Add(Panel($"ENV {ek[3]}", purple, env));
        }
        foreach (var key in new[] { "lfo1", "lfo2", "lfo3", "lfo4" })
        {
            var l = (JsonObject)W[key]!;
            var sp = new StackPanel();
            var h = Row();
            h.Children.Add(D(96, Shapes.Select(s => (s, s switch { "sine" => "Sinusoide", "triangle" => "Triangolo", "sawtooth" => "Dente sega", _ => "Quadra" })), Doc.Str(l, "shape", "sine"), v => l["shape"] = v));
            h.Children.Add(D(96, Syncs.Select(s => (F(s, "0.##"), s == 0 ? "Libero (Hz)" : $"{F(s, "0.##")} beat")), F(N(l, "sync", 0), "0.##"), v => l["sync"] = double.Parse(v, CultureInfo.InvariantCulture)));
            sp.Children.Add(h);
            var r = Row();
            r.Children.Add(K("RATE", 0.02, 30, 2, () => N(l, "rate", 2), v => l["rate"] = v, v => F(v, "0.00") + " Hz", log: true, col: purple));
            sp.Children.Add(r);
            mRow.Children.Add(Panel($"LFO {key[3]}", purple, sp, 210));
        }
        var st = (JsonObject)W["step"]!;
        var stepSp = new StackPanel();
        var steps = new StepperBars((JsonArray)st["values"]!) { Height = 90, Width = 260, Margin = new Thickness(8, 0, 8, 4) };
        steps.Begin += Begin; steps.Changed += () => Push(); steps.End += End;
        stepSp.Children.Add(steps);
        var sr = Row();
        sr.Children.Add(Txt.Make("Passo", 10, Theme.Dim));
        sr.Children.Add(D(80, new[] { 0.5, 1.0, 2.0, 4.0 }.Select(x => (F(x, "0.#"), x == 0.5 ? "1/32" : x == 1 ? "1/16" : x == 2 ? "1/8" : "1/4")), F(N(st, "div", 1), "0.#"), v => st["div"] = double.Parse(v, CultureInfo.InvariantCulture)));
        stepSp.Children.Add(sr);
        mRow.Children.Add(Panel("STEPPER", purple, stepSp));

        var macros = (JsonArray)W["macros"]!;
        var names = (JsonArray)W["macroNames"]!;
        var mac = Row();
        for (int i = 0; i < 8; i++)
        {
            int ii = i;
            var box = new StackPanel();
            var kb = K((names[ii]?.ToString() ?? $"Macro {ii + 1}").ToUpperInvariant(), 0, 1, 0, () => Doc.Val(macros[ii]), v => macros[ii] = v, Pct, col: Theme.Orange);
            kb.LearnId = $"wtmacro:{ch}:{ii}";
            box.Children.Add(kb);
            var rn = new Btn("✎", 0, "Rinomina la macro") { Padding = new Thickness(4, 0, 4, 0), HorizontalAlignment = HorizontalAlignment.Center };
            rn.Click += () => { var n = Prompt.Ask(this, $"Nome della macro {ii + 1}", names[ii]?.ToString() ?? ""); if (n != null) { Begin(); names[ii] = n[..Math.Min(16, n.Length)]; Push(true); End(); } };
            box.Children.Add(rn);
            mac.Children.Add(box);
        }
        var macSp = new StackPanel();
        macSp.Children.Add(mac);
        macSp.Children.Add(Txt.Make("Collega le macro ai parametri nella matrice (sorgente = nome della macro). Tasto destro su una macro: MIDI Learn.", 11, Theme.Dim));
        body.Children.Add(Panel("8 MACRO", Theme.Orange, macSp));

        var mods = (JsonArray)W["mod"]!;
        var mx = new StackPanel { Margin = new Thickness(6, 0, 6, 6) };
        for (int i = 0; i < mods.Count; i++)
        {
            var m = (JsonObject)mods[i]!;
            int idx = i;
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            row.Children.Add(D(110, Sources.Select(s => (s, SourceName(s))), Doc.Str(m, "src", "lfo1"), v => m["src"] = v));
            row.Children.Add(Txt.Make("→", 12, Theme.Dim));
            row.Children.Add(D(122, Dests.Select(s => (s, DestName[s])), Doc.Str(m, "dst", "pos"), v => m["dst"] = v));
            var amt = new HSlider(-1, 1, 0, N(m, "amt", 0)) { Width = 110, Color = purple, VerticalAlignment = VerticalAlignment.Center, ToolTip = "Quantità (doppio clic: 0)" };
            var at = Txt.Make(F(N(m, "amt", 0) * 100, "+0;-0;0"), 10, Theme.Lcd); at.Width = 30; at.VerticalAlignment = VerticalAlignment.Center;
            amt.Begin += Begin; amt.Changed += v => { m["amt"] = Math.Round(v, 3); at.Text = F(v * 100, "+0;-0;0"); Push(); }; amt.End += End;
            row.Children.Add(amt); row.Children.Add(at);
            var x = new Btn("×", 0, "Togli") { Padding = new Thickness(4, 0, 4, 0) };
            x.Click += () => { Begin(); mods.RemoveAt(idx); Push(true); End(); };
            row.Children.Add(x);
            mx.Children.Add(row);
        }
        if (mods.Count < ModSlots)
        {
            var add = new Btn("＋ MODULAZIONE", 0, "Collega una sorgente (LFO, inviluppo, stepper, velocity) a un parametro");
            add.Click += () => { Begin(); mods.Add(new JsonObject { ["src"] = "lfo1", ["dst"] = "pos", ["amt"] = 0.5 }); Push(true); End(); };
            mx.Children.Add(add);
        }
        mRow.Children.Add(Panel("MATRICE DI MODULAZIONE", purple, mx, 420));
        body.Children.Add(mRow);
    }

    /// <summary>Forma d'onda dell'oscillatore alla posizione corrente della tabella.</summary>
    sealed class WaveDisplay : FrameworkElement
    {
        public string Table = "analog"; public double Pos; public Brush Color = Brushes.Orange;
        protected override void OnRender(DrawingContext dc)
        {
            double w = ActualWidth, h = ActualHeight;
            dc.DrawRoundedRectangle(Theme.Dark, null, new Rect(0, 0, w, h), 4, 4);
            dc.DrawLine(new Pen(Theme.Panel3, 0.5), new Point(0, h / 2), new Point(w, h / 2));
            var s = Wavetable.Shape(Table, Pos, 160);
            double pk = Math.Max(0.001, s.Max(Math.Abs));
            var g = new StreamGeometry();
            using (var c = g.Open())
            {
                for (int i = 0; i < s.Length; i++)
                {
                    var p = new Point(4 + (w - 8) * i / (s.Length - 1), h / 2 - s[i] / pk * (h / 2 - 6));
                    if (i == 0) c.BeginFigure(p, false, false); else c.LineTo(p, true, false);
                }
            }
            g.Freeze();
            dc.DrawGeometry(null, new Pen(Color, 2), g);
        }
    }

    /// <summary>Stepper: 16 barre da disegnare col mouse.</summary>
    sealed class StepperBars : FrameworkElement
    {
        readonly JsonArray v;
        public event Action? Begin, Changed, End;
        bool drag;
        public StepperBars(JsonArray values) { v = values; Cursor = Cursors.Pen; }
        protected override void OnRender(DrawingContext dc)
        {
            double w = ActualWidth, h = ActualHeight, cw = w / 16;
            dc.DrawRoundedRectangle(Theme.Dark, null, new Rect(0, 0, w, h), 4, 4);
            for (int i = 0; i < 16 && i < v.Count; i++)
            {
                double x = Doc.Val(v[i]);
                dc.DrawRectangle(i % 4 == 0 ? Theme.Track(10) : new SolidColorBrush(Color.FromArgb(200, 0xa9, 0x8b, 0xe0)), null, new Rect(i * cw + 2, h - 2 - x * (h - 4), cw - 4, x * (h - 4)));
            }
        }
        void Set(Point p)
        {
            int i = Math.Clamp((int)(p.X / (ActualWidth / 16)), 0, 15);
            v[i] = Math.Round(Math.Clamp(1 - (p.Y - 2) / (ActualHeight - 4), 0, 1), 3);
            InvalidateVisual(); Changed?.Invoke();
        }
        protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e) { Begin?.Invoke(); drag = true; CaptureMouse(); Set(e.GetPosition(this)); }
        protected override void OnMouseMove(MouseEventArgs e) { if (drag) Set(e.GetPosition(this)); }
        protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e) { if (!drag) return; drag = false; ReleaseMouseCapture(); End?.Invoke(); }
    }
}
