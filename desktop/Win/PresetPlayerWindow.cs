// PresetPlayerWindow.cs — Strumento "Preset Player" in una finestra a parte (non modale), sul
// modello dei ROMpler come Nexus: browser di preset per categoria con ricerca e preferiti,
// display con ◀ ▶, macro, arpeggiatore e trance gate. Si applica come strumento a una traccia
// synth, anche vuota. Usa i suoni del motore (analogici, FM, piano, corde, organo, wavetable).
//
// Dati (compatibili con web app e motore C#): track.preset, parametri della traccia (cut, res, env,
// atk, dec, rel, lfo, rate, rev, dly, vol), track.arp, e il trance gate come automazione del
// volume per step (pattern.auto["s<k>.vol"]).

using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using DrumBort.Host;

namespace DrumBort.Win;

public sealed class PresetPlayerWindow : Window
{
    static PresetPlayerWindow? current;
    readonly Doc doc;
    int ch = 8;
    string pending = "";                 // preset scelto (non ancora applicato se la traccia non è collegata)
    string cat = "", query = "";
    readonly StackPanel list = new();
    readonly StackPanel cats = new();
    readonly StackPanel right = new() { Margin = new Thickness(10) };
    readonly TextBox search = new() { FontSize = 13, Background = Theme.Dark, Foreground = Theme.Ink, BorderBrush = Theme.Edge, CaretBrush = Theme.Ink, Padding = new Thickness(6, 3, 6, 3), Margin = new Thickness(6) };
    readonly HashSet<string> fav = (Settings.Load("favPresets") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).ToHashSet();

    sealed record Info(string Id, string Name, string Cat, string[] Tags);
    static List<Info>? all;
    static List<Info> All()
    {
        if (all != null) return all;
        var o = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Assets", "presets.json")))!.AsObject();
        return all = o.Select(kv => new Info(kv.Key, Doc.Str(kv.Value, "name", kv.Key), Doc.Str(kv.Value, "cat", "Altro"),
            (kv.Value?["tags"] as JsonArray)?.Select(t => t?.ToString() ?? "").ToArray() ?? Array.Empty<string>())).OrderBy(i => i.Cat).ThenBy(i => i.Name).ToList();
    }

    public static void Open(Window owner, Doc doc, int ch, bool applyNow = false)
    {
        if (current == null) { current = new PresetPlayerWindow(doc) { Owner = owner }; current.Show(); }
        current.Target(ch);
        if (applyNow) current.Apply(current.pending == "" ? All()[0].Id : current.pending);
        current.Activate();
    }
    public static PresetPlayerWindow? Current => current;

    PresetPlayerWindow(Doc doc)
    {
        this.doc = doc;
        Title = "Preset Player";
        Width = 1120; Height = 760; MinWidth = 860; MinHeight = 560;
        Background = Theme.Bg; Foreground = Theme.Ink; FontFamily = Theme.Font;
        var root = new Grid();
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(150) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(290) });
        root.ColumnDefinitions.Add(new ColumnDefinition());
        var catBox = new DockPanel { Background = Theme.Panel };
        var ct = Txt.Make("CATEGORIE", 11, Theme.Dim, true); ct.Margin = new Thickness(8, 8, 8, 4);
        DockPanel.SetDock(ct, Dock.Top); catBox.Children.Add(ct);
        catBox.Children.Add(new ScrollViewer { Content = cats, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        root.Children.Add(catBox);
        var lb = new DockPanel { Background = Theme.Panel2 };
        DockPanel.SetDock(search, Dock.Top); lb.Children.Add(search);
        search.ToolTip = "Cerca per nome, categoria o tag";
        search.TextChanged += (_, _) => { query = search.Text.Trim().ToLowerInvariant(); RenderList(); };
        lb.Children.Add(new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        Grid.SetColumn(lb, 1); root.Children.Add(lb);
        var rs = new ScrollViewer { Content = right, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetColumn(rs, 2); root.Children.Add(rs);
        Content = root;
        Closed += (_, _) => current = null;
        doc.Changed += OnDoc;
        Closed += (_, _) => doc.Changed -= OnDoc;
        PreviewKeyDown += (_, e) =>
        {
            if (Keyboard.FocusedElement is TextBox) return;
            if (e.Key == Key.Space) { Preview(); e.Handled = true; }
            else if (e.Key is Key.Right or Key.Down) { Step(1); e.Handled = true; }
            else if (e.Key is Key.Left or Key.Up) { Step(-1); e.Handled = true; }
        };
    }

    void OnDoc() { if (IsLoaded) { RenderList(); RenderRight(); } }

    bool Linked => doc.Tracks.Contains(ch) && Doc.TrackOf(doc.Pat, ch)["patch"] is not JsonObject;
    JsonObject Tr => Doc.TrackOf(doc.Pat, ch);
    string Cur => Linked ? Doc.Str(Tr, "preset", "") : pending;

    void Target(int c)
    {
        ch = Math.Clamp(c, 8, 11);
        pending = Linked ? Doc.Str(Tr, "preset", "") : pending;
        RenderCats(); RenderList(); RenderRight();
    }

    /// <summary>Preset alla traccia (tutti i pattern); la traccia vuota diventa attiva.</summary>
    void Apply(string id)
    {
        pending = id;
        doc.Snapshot();
        if (!doc.Tracks.Contains(ch)) { doc.SetTracks(doc.Tracks.Append(ch)); doc.SetAll(ch, "mute", false); }
        for (int i = 0; i < Doc.Slots; i++) { var t = Doc.TrackOf(doc.PatAt(i), ch); t["preset"] = id; t.Remove("patch"); }
        doc.Commit(doc.AllPatKeys.Append("tracks").ToArray());
        Preview();
    }

    /// <summary>Scelta di un preset: suona subito se la traccia è collegata (come nei ROMpler).</summary>
    void Pick(string id)
    {
        pending = id;
        if (Linked) Apply(id); else { RenderList(); RenderRight(); }
    }

    void Step(int d)
    {
        var l = Filtered();
        if (l.Count == 0) return;
        int i = l.FindIndex(x => x.Id == Cur);
        Pick(l[((i < 0 ? 0 : i + d) % l.Count + l.Count) % l.Count].Id);
    }

    void Preview()
    {
        if (!Linked) return;
        int k = ch - 8, b = doc.Base(k);
        doc.PreviewSynth(k, b);
    }

    List<Info> Filtered() => All().Where(p =>
        (cat == "" || (cat == "★" ? fav.Contains(p.Id) : p.Cat == cat)) &&
        (query == "" || (p.Name + " " + p.Cat + " " + string.Join(" ", p.Tags)).ToLowerInvariant().Contains(query))).ToList();

    // ------------------------------------------------------------------ browser
    void RenderCats()
    {
        cats.Children.Clear();
        foreach (var c in new[] { "", "★" }.Concat(All().Select(p => p.Cat).Distinct()))
        {
            int n = c == "" ? All().Count : c == "★" ? fav.Count : All().Count(p => p.Cat == c);
            var b = new Btn($"{(c == "" ? "Tutti" : c == "★" ? "★ Preferiti" : c)}  ({n})") { IsOn = c == cat, HorizontalAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(4, 1, 4, 1) };
            var cc = c;
            b.Click += () => { cat = cc; RenderCats(); RenderList(); };
            cats.Children.Add(b);
        }
    }

    void RenderList()
    {
        list.Children.Clear();
        string cur = Cur;
        foreach (var p in Filtered())
        {
            bool on = p.Id == cur;
            var row = new DockPanel { Margin = new Thickness(8, 4, 4, 4) };
            var star = Txt.Make(fav.Contains(p.Id) ? "★" : "☆", 15, fav.Contains(p.Id) ? Theme.Orange : Theme.Dim);
            star.Cursor = Cursors.Hand; star.ToolTip = "Preferito"; star.Margin = new Thickness(0, 0, 6, 0);
            var pid = p.Id;
            star.MouseLeftButtonUp += (_, e) =>
            {
                if (!fav.Remove(pid)) fav.Add(pid);
                Settings.Save("favPresets", string.Join(",", fav));
                RenderCats(); RenderList(); e.Handled = true;
            };
            DockPanel.SetDock(star, Dock.Right);
            row.Children.Add(star);
            var sp = new StackPanel();
            sp.Children.Add(Txt.Make(p.Name, 13, on ? Theme.Lcd : Theme.Ink, on));
            sp.Children.Add(Txt.Make(p.Cat + (p.Tags.Length > 0 ? " · " + string.Join(", ", p.Tags.Take(3)) : ""), 10, Theme.Dim));
            row.Children.Add(sp);
            var b = new Border { Child = row, Background = on ? Theme.OnBg : Brushes.Transparent, BorderBrush = on ? Theme.Orange : Theme.Panel3, BorderThickness = new Thickness(on ? 3 : 0, 0, 0, 1), Cursor = Cursors.Hand };
            b.MouseEnter += (_, _) => { if (!on) b.Background = Theme.Hover; };
            b.MouseLeave += (_, _) => { if (!on) b.Background = Brushes.Transparent; };
            b.MouseLeftButtonUp += (_, _) => Pick(pid);
            list.Children.Add(b);
        }
        if (list.Children.Count == 0) { var t = Txt.Make("Nessun preset.", 12, Theme.Dim); t.Margin = new Thickness(10); list.Children.Add(t); }
    }

    // ------------------------------------------------------------------ display, macro, arp, gate
    static Border Panel(string title, Brush accent, UIElement content)
    {
        var sp = new StackPanel();
        var h = Txt.Make(title, 11, accent, true); h.Margin = new Thickness(8, 5, 8, 3);
        sp.Children.Add(h); sp.Children.Add(content);
        return new Border { Background = Theme.Panel, BorderBrush = accent, BorderThickness = new Thickness(0, 3, 0, 0), CornerRadius = new CornerRadius(4), Margin = new Thickness(0, 0, 0, 10), Child = sp };
    }
    static string F(double v, string f) => v.ToString(f, CultureInfo.InvariantCulture);

    void RenderRight()
    {
        right.Children.Clear();
        var info = All().FirstOrDefault(p => p.Id == Cur);

        // Display LCD con ◀ ▶
        var lcd = new Grid { Height = 92 };
        lcd.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(44) });
        lcd.ColumnDefinitions.Add(new ColumnDefinition());
        lcd.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(44) });
        var prev = new Btn("◀", 40, "Preset precedente (←)") { VerticalAlignment = VerticalAlignment.Stretch }; prev.Click += () => Step(-1);
        var next = new Btn("▶", 40, "Preset successivo (→)") { VerticalAlignment = VerticalAlignment.Stretch }; next.Click += () => Step(1);
        Grid.SetColumn(next, 2);
        var screen = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        var nm = Txt.Make(info?.Name ?? "Scegli un preset", 26, Theme.Lcd, true); nm.HorizontalAlignment = HorizontalAlignment.Center;
        var sub = Txt.Make(info != null ? $"{info.Cat.ToUpperInvariant()}  ·  {string.Join(" · ", info.Tags)}" : "", 11, Theme.Dim); sub.HorizontalAlignment = HorizontalAlignment.Center;
        screen.Children.Add(nm); screen.Children.Add(sub);
        var scr = new Border { Background = new LinearGradientBrush(Color.FromRgb(0x10, 0x1a, 0x14), Color.FromRgb(0x1b, 0x2a, 0x1f), 90), CornerRadius = new CornerRadius(6), BorderBrush = Theme.Edge, BorderThickness = new Thickness(1), Margin = new Thickness(6, 0, 6, 0), Child = screen };
        Grid.SetColumn(scr, 1);
        lcd.Children.Add(prev); lcd.Children.Add(scr); lcd.Children.Add(next);
        right.Children.Add(lcd);

        // Traccia, applica, ascolta
        var bar = new WrapPanel { Margin = new Thickness(0, 10, 0, 10) };
        bar.Children.Add(Txt.Make("TRACCIA ", 10, Theme.Dim));
        var tr = new Dropdown(150) { ToolTip = "Traccia synth che suona il preset (le tracce vuote si attivano con APPLICA)" };
        tr.SetItems(Enumerable.Range(8, 4).Select(c => (c.ToString(), $"{Doc.SynthShort[c - 8]} · {Doc.SynthNames[c - 8]}" + (!doc.Tracks.Contains(c) ? " (vuota)" : ""))));
        tr.Value = ch.ToString();
        tr.Changed += v => Target(int.Parse(v));
        bar.Children.Add(tr);
        var apply = new Btn(Linked ? "✓ COLLEGATA" : "APPLICA ALLA TRACCIA", 0, Linked ? "Il preset scelto nella lista suona subito sulla traccia" : "Usa il preset come strumento della traccia (anche vuota)") { IsOn = !Linked, Fg = Linked ? Theme.Green : Theme.Ink };
        apply.Click += () => { if (!Linked && Cur != "") Apply(Cur); };
        bar.Children.Add(apply);
        var play = new Btn("▶ ASCOLTA", 0, "Suona la tonica (Spazio)"); play.Click += Preview; bar.Children.Add(play);
        if (!Linked) bar.Children.Add(Txt.Make("  APPLICA per suonare e modificare il preset.", 11, Theme.Dim));
        right.Children.Add(bar);
        if (!Linked) return;

        // Macro: parametri della traccia (in tutti i pattern)
        var t = Tr;
        var mac = new WrapPanel { Margin = new Thickness(6, 0, 6, 6) };
        Knob M(string k, string label, double min, double max, double def, Func<double, string> fmt)
        {
            var kb = new Knob(label, min, max, def, Doc.Num(t, k, def), fmt) { Color = Theme.Orange, LearnId = $"trk:{ch}:{k}", Width = 70 };
            kb.Begin += () => doc.Snapshot();
            kb.Changed += v => { doc.SetAll(ch, k, v); doc.CommitQuiet(doc.AllPatKeys); };
            kb.End += () => doc.Commit(doc.AllPatKeys);
            return kb;
        }
        string Sig(double v) => F(v, "+0.00;-0.00;0");
        string X(double v) => "×" + F(v, "0.00");
        string Pc(double v) => F(v * 100, "0") + " %";
        mac.Children.Add(M("cut", "CUTOFF", -1, 1, 0, Sig));
        mac.Children.Add(M("res", "RESONANCE", -1, 1, 0, Sig));
        mac.Children.Add(M("env", "FILTER ENV", 0, 2, 1, X));
        mac.Children.Add(M("atk", "ATTACK", 0.1, 4, 1, X));
        mac.Children.Add(M("dec", "DECAY", 0.25, 3, 1, X));
        mac.Children.Add(M("rel", "RELEASE", 0.1, 4, 1, X));
        mac.Children.Add(M("lfo", "LFO DEPTH", 0, 2, 1, X));
        mac.Children.Add(M("rate", "LFO RATE", 0.25, 4, 1, X));
        mac.Children.Add(M("rev", "REVERB", 0, 1, 0, Pc));
        mac.Children.Add(M("dly", "DELAY", 0, 1, 0, Pc));
        mac.Children.Add(M("vol", "VOLUME", 0, 1, 0.7, Pc));
        right.Children.Add(Panel("MACRO", Theme.Orange, mac));

        // Arpeggiatore
        if (t["arp"] is not JsonObject) t["arp"] = new JsonObject { ["on"] = false, ["mode"] = "up", ["rate"] = 1, ["oct"] = 1, ["gate"] = 0.6, ["src"] = 2 };
        var arp = (JsonObject)t["arp"]!;
        var ap = new WrapPanel { Margin = new Thickness(6, 0, 6, 6) };
        void SetArp(string k, JsonNode v) { doc.Snapshot(); for (int i = 0; i < Doc.Slots; i++) { var a = Doc.TrackOf(doc.PatAt(i), ch)["arp"] as JsonObject ?? new JsonObject(); a[k] = v.DeepClone(); Doc.TrackOf(doc.PatAt(i), ch)["arp"] = a; } doc.Commit(doc.AllPatKeys); }
        var on = new Btn(Doc.Bool(arp, "on") ? "ARP ON" : "ARP OFF") { IsOn = Doc.Bool(arp, "on"), Margin = new Thickness(2, 4, 8, 4) };
        on.Click += () => SetArp("on", !Doc.Bool(arp, "on"));
        ap.Children.Add(on);
        void Opts(string label, string k, IEnumerable<(string v, string l)> items, string cur, Func<string, JsonNode> conv)
        {
            ap.Children.Add(Txt.Make(label, 10, Theme.Dim));
            foreach (var (v, l) in items)
            {
                var b = new Btn(l) { IsOn = v == cur, Padding = new Thickness(6, 1, 6, 1), Margin = new Thickness(1, 4, 1, 4) };
                b.Click += () => SetArp(k, conv(v));
                ap.Children.Add(b);
            }
            ap.Children.Add(new Border { Width = 10 });
        }
        Opts("MODO ", "mode", new[] { ("up", "Su"), ("down", "Giù"), ("updown", "Su-giù"), ("random", "Casuale") }, Doc.Str(arp, "mode", "up"), v => JsonValue.Create(v)!);
        Opts("PASSO ", "rate", new[] { ("0.5", "1/32"), ("1", "1/16"), ("2", "1/8"), ("4", "1/4") }, F(Doc.Num(arp, "rate", 1), "0.#"), v => JsonValue.Create(double.Parse(v, CultureInfo.InvariantCulture))!);
        Opts("OTTAVE ", "oct", new[] { ("1", "1"), ("2", "2"), ("3", "3") }, F(Doc.Num(arp, "oct", 1), "0"), v => JsonValue.Create(int.Parse(v))!);
        var gate = new Knob("GATE", 0.1, 1, 0.6, Doc.Num(arp, "gate", 0.6), Pc) { Color = Theme.Cyan, Width = 66 };
        gate.Begin += () => doc.Snapshot();
        gate.Changed += v => { for (int i = 0; i < Doc.Slots; i++) if (Doc.TrackOf(doc.PatAt(i), ch)["arp"] is JsonObject a) a["gate"] = v; doc.CommitQuiet(doc.AllPatKeys); };
        gate.End += () => doc.Commit(doc.AllPatKeys);
        ap.Children.Add(gate);
        right.Children.Add(Panel("ARPEGGIATORE · le note della traccia diventano arpeggi", Theme.Cyan, ap));

        // Trance gate: automazione del volume per step (pattern corrente o tutti)
        right.Children.Add(Panel("TRANCE GATE · volume a tempo, 16 step", Theme.Track(10), GatePanel()));
    }

    static readonly (string name, string bits)[] GatePresets =
    {
        ("1/8", "1010101010101010"), ("1/4", "1000100010001000"), ("Offbeat", "0010001000100010"),
        ("Trance", "1011101010111010"), ("Sincopi", "1001001010010010"), ("Pump", "0111011101110111"),
    };

    UIElement GatePanel()
    {
        string key = $"s{ch - 8}.vol";
        var sp = new StackPanel { Margin = new Thickness(6, 0, 6, 6) };
        var lane = doc.Pat["auto"]?[key] as JsonArray;
        double vol = Doc.Num(Tr, "vol", 0.7);
        bool[] bits = new bool[16];
        double depth = 0.85;
        if (lane != null && lane.Count > 0)
        {
            var vals = lane.Select(x => x == null ? vol : Doc.Val(x)).ToList();
            double hi = vals.Max(), lo = vals.Min();
            for (int i = 0; i < 16; i++) bits[i] = vals[i % vals.Count] >= hi - 1e-6;
            depth = hi > 0 ? Math.Round(1 - lo / hi, 2) : 0.85;
        }
        else for (int i = 0; i < 16; i++) bits[i] = i % 2 == 0;
        var grid = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 6) };
        for (int i = 0; i < 16; i++)
        {
            int ii = i;
            var b = new Border { Width = 24, Height = 30, Margin = new Thickness(i % 4 == 0 ? 6 : 1, 0, 1, 0), CornerRadius = new CornerRadius(3), Background = bits[i] ? Theme.Track(10) : Theme.Dark, BorderBrush = Theme.Edge, BorderThickness = new Thickness(1), Cursor = Cursors.Hand };
            b.MouseLeftButtonDown += (_, _) => { bits[ii] = !bits[ii]; b.Background = bits[ii] ? Theme.Track(10) : Theme.Dark; if (lane != null) Write(bits, depth, false); };
            grid.Children.Add(b);
        }
        sp.Children.Add(grid);
        var row = new WrapPanel();
        var on = new Btn(lane != null ? "GATE ON" : "GATE OFF", 0, "Attiva o disattiva il trance gate su questo pattern") { IsOn = lane != null };
        on.Click += () => { if (lane != null) Clear(false); else Write(bits, depth, false); };
        row.Children.Add(on);
        foreach (var (n, pattern) in GatePresets)
        {
            var b = new Btn(n) { Padding = new Thickness(6, 1, 6, 1) };
            b.Click += () => Write(pattern.Select(c => c == '1').ToArray(), depth, false);
            row.Children.Add(b);
        }
        var dk = new Knob("DEPTH", 0, 1, 0.85, depth, v => F(v * 100, "0") + " %") { Color = Theme.Track(10), Width = 66 };
        dk.End += () => { depth = dk.Value; if (lane != null) Write(bits, depth, false); };
        row.Children.Add(dk);
        var allB = new Btn("SU TUTTI I PATTERN", 0, "Copia il gate (o lo toglie) in tutti gli 8 pattern");
        allB.Click += () => { if (lane != null) Write(bits, depth, true); else Clear(true); };
        row.Children.Add(allB);
        sp.Children.Add(row);
        return sp;
    }

    /// <summary>Gate → automazione del volume: step accesi al volume della traccia, spenti ridotti di `depth`.</summary>
    void Write(bool[] bits, double depth, bool allPatterns)
    {
        string key = $"s{ch - 8}.vol";
        doc.Snapshot();
        foreach (int i in allPatterns ? Enumerable.Range(0, Doc.Slots) : new[] { doc.Slot })
        {
            var p = doc.PatAt(i);
            double vol = Doc.Num(Doc.TrackOf(p, ch), "vol", 0.7);
            int n = 16 * (Doc.Num(p, "bars", 1) is var b && (b == 2 || b == 4) ? (int)b : 1);
            if (p["auto"] is not JsonObject auto) p["auto"] = auto = new JsonObject();
            auto[key] = new JsonArray(Enumerable.Range(0, n).Select(s => (JsonNode)Math.Round(bits[s % 16] ? vol : vol * (1 - depth), 3)).ToArray());
        }
        doc.Commit(doc.AllPatKeys);
    }
    void Clear(bool allPatterns)
    {
        string key = $"s{ch - 8}.vol";
        doc.Snapshot();
        foreach (int i in allPatterns ? Enumerable.Range(0, Doc.Slots) : new[] { doc.Slot })
            (doc.PatAt(i)["auto"] as JsonObject)?.Remove(key);
        doc.Commit(doc.AllPatKeys);
    }
}
