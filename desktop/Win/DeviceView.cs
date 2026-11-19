// DeviceView.cs — Device View della traccia selezionata (come in Ableton Live):
//   [Strumento] → device audio (ordine libero) → [Mixer: volume, pan, mandate]
// Barra del titolo: attivatore, nome, piega, menu (Duplica, Ripristina valori, Elimina).
// Riordino trascinando la barra del titolo; aggiunta dal browser (EFFETTI) trascinando o con
// doppio clic, o con "＋ EFFETTO". Canc elimina il device selezionato, Ctrl+D lo duplica.

using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using DrumBort.Host;

namespace DrumBort.Win;

/// <summary>Tipi di device (Assets/devices.json, esportato da js/devices.js).</summary>
public static class DeviceSpecs
{
    public sealed record Param(string K, string Label, string Kind, double Min, double Max, JsonNode? Def, bool Log, string Unit, (string v, string l)[] Options);
    public sealed record Spec(string Type, string Name, string Cat, string Desc, Param[] Params);
    public static readonly List<Spec> All = new();
    public static readonly List<string> Categories = new();

    public static void Load(string path)
    {
        var o = JsonNode.Parse(File.ReadAllText(path))!;
        Categories.AddRange(((JsonArray)o["categories"]!).Select(x => x!.GetValue<string>()));
        foreach (var d in (JsonArray)o["devices"]!)
        {
            var ps = ((JsonArray)d!["params"]!).Select(p => new Param(
                p!["k"]!.GetValue<string>(), p["label"]!.GetValue<string>(), p["kind"]!.GetValue<string>(),
                Doc.Num(p, "min", 0), Doc.Num(p, "max", 1), p["def"]?.DeepClone(), Doc.Str(p, "curve", "") == "log", Doc.Str(p, "unit", "num"),
                p["options"] is JsonArray op ? op.Select(x => (x![0]!.GetValue<string>(), x[1]!.GetValue<string>())).ToArray() : Array.Empty<(string, string)>())).ToArray();
            All.Add(new Spec(d["type"]!.GetValue<string>(), d["name"]!.GetValue<string>(), d["cat"]!.GetValue<string>(), Doc.Str(d, "desc", ""), ps));
        }
    }
    public static Spec? Get(string type) => All.FirstOrDefault(s => s.Type == type);

    public static string Format(Param p, double v)
    {
        var ci = CultureInfo.InvariantCulture;
        return p.Unit switch
        {
            "hz" => v >= 1000 ? (v / 1000).ToString(v >= 10000 ? "0.0" : "0.00", ci) + " kHz" : Math.Round(v).ToString(ci) + " Hz",
            "db" => (v > 0 ? "+" : "") + v.ToString("0.0", ci) + " dB",
            "pct" => Math.Round(v * 100).ToString(ci) + " %",
            "ms" => v >= 100 ? Math.Round(v) + " ms" : v.ToString("0.0", ci) + " ms",
            "s" => v.ToString("0.00", ci) + " s",
            "ratio" => v >= 19.9 ? "∞ : 1" : v.ToString("0.0", ci) + " : 1",
            "bit" => Math.Round(v) + " bit",
            _ => v.ToString("0.00", ci),
        };
    }

    static int seq;
    /// <summary>Nuovo device con i valori iniziali (come newDevice in js/devices.js).</summary>
    public static JsonObject New(string type)
    {
        var s = Get(type)!;
        var p = new JsonObject();
        foreach (var x in s.Params) p[x.K] = x.Def?.DeepClone();
        return new JsonObject { ["id"] = $"w{DateTime.UtcNow.Ticks:x}{seq++}", ["type"] = type, ["on"] = true, ["p"] = p };
    }
}

public sealed class DeviceView : DockPanel
{
    const string MoveFmt = "drumbort/dev", NewFmt = "drumbort/newdev";
    readonly Doc doc;
    readonly StackPanel chain = new() { Orientation = Orientation.Horizontal };
    readonly ScrollViewer scroll;
    readonly TextBlock title = Txt.Make("", 14, null, true);
    readonly TextBlock subtitle = Txt.Make("", 12, Theme.Dim);
    public int Ch = -1;
    string? sel;
    public Action<int>? OpenLibrary;
    public Action<int>? OpenWavetable;
    public Action? ShowNotes;

    public DeviceView(Doc doc)
    {
        this.doc = doc;
        Background = Theme.Panel;
        var head = new DockPanel { Margin = new Thickness(8, 6, 8, 4), LastChildFill = false };
        var names = new StackPanel { Orientation = Orientation.Horizontal };
        names.Children.Add(title); subtitle.Margin = new Thickness(8, 0, 0, 0); names.Children.Add(subtitle);
        DockPanel.SetDock(names, Dock.Left); head.Children.Add(names);
        var notes = new Btn("✎ NOTE", 0, "Note della traccia (piano roll / step)");
        notes.Click += () => ShowNotes?.Invoke();
        DockPanel.SetDock(notes, Dock.Right); head.Children.Add(notes);
        DockPanel.SetDock(head, Dock.Top);
        Children.Add(head);
        scroll = new ScrollViewer { HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, Content = chain, Padding = new Thickness(6, 0, 6, 6) };
        Children.Add(scroll);
        Focusable = true;
        AllowDrop = true;
        chain.AllowDrop = true;
        chain.DragOver += OnDragOver;
        chain.Drop += OnDrop;
        KeyDown += OnKey;
    }

    public void Render()
    {
        chain.Children.Clear();
        if (Ch < 0 || (Doc.IsBus(Ch) ? !doc.BusExists(Ch) : !doc.Tracks.Contains(Ch)))
        {
            title.Text = "Nessuna traccia selezionata"; subtitle.Text = "";
            chain.Children.Add(Txt.Make("Seleziona una traccia (clic sul nome) o creane una con ＋ TRACCIA.", 13, Theme.Dim));
            return;
        }
        title.Text = doc.ChShort(Ch); title.Foreground = Theme.Track(Ch);
        subtitle.Text = doc.ChName(Ch);
        chain.Children.Add(Doc.IsBus(Ch) ? BusBox() : Instrument());
        var c = doc.Chain(Ch);
        for (int i = 0; i < c.Count; i++) chain.Children.Add(Device((JsonObject)c[i]!, i));
        chain.Children.Add(DropZone());
        if (!Doc.IsBus(Ch)) chain.Children.Add(MixerBox());
    }

    // ------------------------------------------------------------------ riquadri
    static Border Box(Brush top, double minW = 120) => new()
    {
        Background = Theme.Panel2, BorderBrush = Theme.Panel3, BorderThickness = new Thickness(1, 2, 1, 1),
        CornerRadius = new CornerRadius(4), Margin = new Thickness(0, 0, 6, 0), MinWidth = minW,
    };
    static UIElement Header(string text, params UIElement[] right)
    {
        var d = new DockPanel { Background = Theme.Panel3, Height = 26, LastChildFill = true };
        foreach (var r in right.Reverse()) { DockPanel.SetDock(r, Dock.Right); d.Children.Add(r); }
        var t = Txt.Make(text.ToUpperInvariant(), 10.5, Theme.Ink, true);
        t.Margin = new Thickness(8, 0, 4, 0);
        d.Children.Add(t);
        return d;
    }
    static WrapPanel KnobGrid() => new() { Orientation = Orientation.Vertical, MaxHeight = 160, Margin = new Thickness(6, 4, 6, 6) };

    Knob TrackKnob(string k, string label, double min, double max, double def, Func<double, string> fmt)
    {
        var kb = new Knob(label, min, max, def, Doc.Num(doc.Track(Ch), k, def), fmt) { Color = Theme.Track(Ch), LearnId = $"trk:{Ch}:{k}" };
        kb.Begin += () => doc.Snapshot();
        kb.Changed += v => { doc.SetAll(Ch, k, v); doc.CommitQuiet(doc.AllPatKeys); };
        kb.End += () => doc.Commit(doc.AllPatKeys);
        return kb;
    }

    // ------------------------------------------------------------------ ritorni, master, stack
    Knob FxKnob(string k, string label, double min, double max, double def, Func<double, string> fmt, bool integer = false)
    {
        var fx = (JsonObject)(doc.Root["fx"] ??= new JsonObject());
        var kb = new Knob(label, min, max, def, Doc.Num(fx, k, def), fmt) { Color = Theme.Track(Ch), Integer = integer, LearnId = $"fx:{k}" };
        kb.Begin += () => doc.Snapshot();
        kb.Changed += v => { fx[k] = v; doc.CommitQuiet("fx"); };
        kb.End += () => doc.Commit("fx");
        return kb;
    }

    UIElement BusBox()
    {
        var b = Box(Theme.Track(Ch));
        var sp = new StackPanel();
        var g = KnobGrid();
        string Pct(double v) => Math.Round(v * 100) + " %";
        string F2(double v) => v.ToString("0.00", CultureInfo.InvariantCulture);
        string Sig(double v) => Math.Abs(v) < 0.02 ? "OFF" : (v < 0 ? "LP " : "HP ") + Math.Round(Math.Abs(v) * 100);
        switch (Ch)
        {
            case Doc.RetA:
                sp.Children.Add(Header("Riverbero (mandata A)"));
                g.Children.Add(FxKnob("rev", "Ritorno", 0, 1, 0.8, Pct));
                g.Children.Add(FxKnob("size", "Durata", 0.4, 6, 2.2, v => F2(v) + " s"));
                break;
            case Doc.RetB:
                sp.Children.Add(Header("Delay (mandata B)"));
                g.Children.Add(FxKnob("dly", "Ritorno", 0, 1, 0.7, Pct));
                g.Children.Add(FxKnob("fb", "Feedback", 0, 0.9, 0.35, Pct));
                g.Children.Add(FxKnob("div", "Tempo", 1, 8, 3, v => $"{v:0}/16", true));
                break;
            case Doc.MasterBus:
            {
                sp.Children.Add(Header("Master"));
                g.Children.Add(FxKnob("master", "Volume", 0, 1, 0.8, Pct));
                g.Children.Add(FxKnob("filter", "Filtro", -1, 1, 0, Sig));
                g.Children.Add(FxKnob("res", "Risonanza", 0.5, 12, 0.7, F2));
                sp.Children.Add(g);
                b.Child = sp;
                // Sidechain in un riquadro a parte: la traccia scelta abbassa i synth (pompaggio)
                var row = new StackPanel { Orientation = Orientation.Horizontal };
                row.Children.Add(b);
                var b2 = Box(Theme.Track(Ch));
                sp = new StackPanel();
                sp.Children.Add(Header("Sidechain → synth"));
                var sg = KnobGrid();
                var fx = (JsonObject)(doc.Root["fx"] ??= new JsonObject());
                var src = new StackPanel { Width = 92, Margin = new Thickness(0, 0, 0, 6) };
                var l = Txt.Make("Sorgente", 9.5, Theme.Dim); l.HorizontalAlignment = HorizontalAlignment.Center;
                src.Children.Add(l);
                var dd = new Dropdown(84) { Margin = new Thickness(2, 4, 2, 2), ToolTip = "La traccia che comanda il sidechain (di solito la cassa)" };
                dd.SetItems(Enumerable.Range(0, 8).Select(i => (i.ToString(), doc.TrackShort(i))));
                dd.Value = ((int)Doc.Num(fx, "scSrc", 0)).ToString();
                dd.Changed += v => { doc.Snapshot(); fx["scSrc"] = int.Parse(v); doc.Commit("fx"); };
                src.Children.Add(dd);
                sg.Children.Add(src);
                sg.Children.Add(FxKnob("sc", "Quantità", 0, 1, 0, Pct));
                sg.Children.Add(FxKnob("scRel", "Rilascio", 0.05, 0.6, 0.18, v => Math.Round(v * 1000) + " ms"));
                sp.Children.Add(sg);
                b2.Child = sp;
                row.Children.Add(b2);
                return row;
            }
            default:
            {
                int s = Ch - Doc.StackBase;
                var st = (JsonObject)doc.StackList[s]!;
                sp.Children.Add(Header($"Track Stack · {Doc.Str(st, "name", "Stack")}"));
                var info = new StackPanel { Margin = new Thickness(8, 6, 8, 6), Width = 170 };
                var members = (st["tracks"] as JsonArray ?? new JsonArray()).Select(x => doc.TrackShort((int)Doc.Val(x)));
                var mt = Txt.Make("Tracce: " + string.Join(", ", members), 12, Theme.Ink); mt.TextWrapping = TextWrapping.Wrap;
                info.Children.Add(mt);
                info.Children.Add(Txt.Make("Gli effetti qui sotto valgono per tutte le tracce dello stack.", 11, Theme.Dim));
                var ren = new Btn("RINOMINA", 0, "Nome dello stack");
                ren.Click += () =>
                {
                    var name = Prompt.Ask(Window.GetWindow(this), "Nome dello stack", Doc.Str(st, "name", "Stack"));
                    if (name != null) { doc.Snapshot(); st["name"] = name; doc.Commit("buses"); }
                };
                info.Children.Add(ren);
                sp.Children.Add(info);
                var vol = new Knob("Volume", 0, 1, 0.8, Doc.Num(st, "vol", 0.8), v => Math.Round(v * 100).ToString(CultureInfo.InvariantCulture)) { Color = Theme.Track(Ch), LearnId = $"stack:{s}:vol" };
                vol.Begin += () => doc.Snapshot();
                vol.Changed += v => { st["vol"] = v; doc.CommitQuiet("buses"); };
                vol.End += () => doc.Commit("buses");
                g.Children.Add(vol);
                break;
            }
        }
        sp.Children.Add(g);
        b.Child = sp;
        return b;
    }

    UIElement Instrument()
    {
        var b = Box(Theme.Track(Ch));
        var sp = new StackPanel();
        bool syn = Doc.IsSynth(Ch);
        sp.Children.Add(Header(syn ? $"{Doc.SynthNames[Ch - 8]} · strumento" : "Voce"));
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        if (syn)
        {
            var info = new StackPanel { Margin = new Thickness(8, 6, 4, 6), Width = 130 };
            var t = doc.Track(Ch);
            string name = t["patch"] is JsonObject p ? Doc.Str(p, "name", "Wavetable") : Doc.PresetName(Doc.Str(t, "preset", ""));
            info.Children.Add(Txt.Make(name, 13, Theme.Lcd, true));
            var lib = new Btn("LIBRERIA", 0, "Scegli il suono nella Libreria");
            lib.Click += () => OpenLibrary?.Invoke(Ch);
            info.Children.Add(lib);
            var wtb = new Btn("WAVETABLE", 0, "Apre l'editor del synth wavetable in una finestra a parte");
            wtb.Click += () => OpenWavetable?.Invoke(Ch);
            info.Children.Add(wtb);
            row.Children.Add(info);
            var g = KnobGrid();
            string Sig(double v) => (v > 0 ? "+" : "") + v.ToString("0.00", CultureInfo.InvariantCulture);
            string F2(double v) => v.ToString("0.00", CultureInfo.InvariantCulture);
            g.Children.Add(TrackKnob("cut", "Cutoff", -1, 1, 0, Sig));
            g.Children.Add(TrackKnob("res", "Reso", -1, 1, 0, Sig));
            g.Children.Add(TrackKnob("env", "Env", 0, 2, 1, F2));
            g.Children.Add(TrackKnob("dec", "Decay", 0.25, 3, 1, F2));
            g.Children.Add(TrackKnob("atk", "Attack", 0.1, 4, 1, F2));
            g.Children.Add(TrackKnob("rel", "Release", 0.1, 4, 1, F2));
            row.Children.Add(g);
        }
        else
        {
            var g = KnobGrid();
            var tune = TrackKnob("tune", "Tune", -12, 12, 0, v => (v > 0 ? "+" : "") + v.ToString("0.#", CultureInfo.InvariantCulture) + " st");
            g.Children.Add(tune);
            g.Children.Add(TrackKnob("decay", "Decay", 0.2, 2.5, 1, v => "×" + v.ToString("0.00", CultureInfo.InvariantCulture)));
            row.Children.Add(g);
        }
        sp.Children.Add(row);
        b.Child = sp;
        return b;
    }

    UIElement MixerBox()
    {
        var b = Box(Theme.Ink);
        var sp = new StackPanel();
        sp.Children.Add(Header("Mixer"));
        var g = KnobGrid();
        string Pct(double v) => Math.Round(v * 100) + " %";
        g.Children.Add(TrackKnob("vol", "Volume", 0, 1, 0.8, v => Math.Round(v * 100).ToString(CultureInfo.InvariantCulture)));
        g.Children.Add(TrackKnob("pan", "Pan", -1, 1, 0, v => Math.Abs(v) < 0.03 ? "C" : (v < 0 ? "L" : "R") + Math.Round(Math.Abs(v) * 100)));
        g.Children.Add(TrackKnob("rev", "Send Rev", 0, 1, 0, Pct));
        g.Children.Add(TrackKnob("dly", "Send Delay", 0, 1, 0, Pct));
        sp.Children.Add(g);
        b.Child = sp;
        return b;
    }

    UIElement DropZone()
    {
        var b = new Border
        {
            BorderBrush = Theme.Edge, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(4), Width = 150, Margin = new Thickness(0, 0, 6, 0),
            Background = Brushes.Transparent, AllowDrop = true, Tag = "drop",
        };
        b.BorderBrush = new SolidColorBrush(Color.FromRgb(0x4a, 0x54, 0x5d)) { };
        var sp = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        var t = Txt.Make("Trascina qui gli\neffetti audio", 11, Theme.Dim);
        t.TextAlignment = TextAlignment.Center; t.TextTrimming = TextTrimming.None;
        sp.Children.Add(t);
        var add = new Btn("＋ EFFETTO", 0, "Aggiungi un effetto alla fine della catena") { Fg = Theme.Green, Margin = new Thickness(4, 8, 4, 4) };
        add.Click += () => Menu.Show(add, DeviceSpecs.Categories.SelectMany(c =>
            new (string, Action?)[] { ("— " + c, null) }.Concat(DeviceSpecs.All.Where(d => d.Cat == c).Select(d => (d.Name, (Action?)(() => Add(d.Type, null)))))));
        sp.Children.Add(add);
        b.Child = sp;
        return b;
    }

    UIElement Device(JsonObject d, int index)
    {
        var spec = DeviceSpecs.Get(Doc.Str(d, "type", "")) ?? DeviceSpecs.All[0];
        string id = Doc.Str(d, "id", "");
        bool on = !(d["on"] is JsonValue ov && ov.TryGetValue(out bool bo) && !bo);
        bool fold = Doc.Bool(d, "fold");
        var col = Theme.Track(Ch);
        var b = Box(col);
        b.Tag = id;
        if (id == sel) { b.BorderBrush = col; b.BorderThickness = new Thickness(2); }
        b.Opacity = on ? 1 : 0.55;

        // Attivatore, piega, menu
        var pw = new Border { Width = 14, Height = 14, CornerRadius = new CornerRadius(7), BorderBrush = Theme.Edge, BorderThickness = new Thickness(1), Background = on ? col : Theme.Dark, Margin = new Thickness(6, 0, 0, 0), Cursor = Cursors.Hand, ToolTip = on ? "Disattiva" : "Attiva" };
        pw.MouseLeftButtonUp += (_, e) => { Edit(() => d["on"] = !on); e.Handled = true; };
        var fb = new Btn(fold ? "▸" : "▾", 0, fold ? "Espandi" : "Piega") { Padding = new Thickness(4, 0, 4, 0), MinHeight = 20, Margin = new Thickness(1) };
        fb.Click += () => Edit(() => d["fold"] = !fold);
        var mb = new Btn("⋯", 0, "Menu del device") { Padding = new Thickness(4, 0, 4, 0), MinHeight = 20, Margin = new Thickness(1) };
        mb.Click += () => Menu.Show(mb, new (string, Action?)[]
        {
            ("Duplica  (Ctrl+D)", () => Duplicate(id)),
            ("Ripristina valori", () => { if (Doc.Str(d, "type", "") != "vst3") Edit(() => d["p"] = DeviceSpecs.New(spec.Type)["p"]!.DeepClone()); }),
            (fold ? "Espandi" : "Piega", () => Edit(() => d["fold"] = !fold)),
            (on ? "Disattiva" : "Attiva", () => Edit(() => d["on"] = !on)),
            ("Elimina  (Canc)", () => Remove(id)),
        });

        var head = new DockPanel { Background = id == sel ? Theme.Hover : Theme.Panel3, Height = 26, Cursor = Cursors.SizeAll, ToolTip = "Trascina per spostare · doppio clic per piegare" };
        DockPanel.SetDock(pw, Dock.Left); head.Children.Add(pw);
        DockPanel.SetDock(mb, Dock.Right); head.Children.Add(mb);
        DockPanel.SetDock(fb, Dock.Right); head.Children.Add(fb);
        bool isVst = Doc.Str(d, "type", "") == "vst3";
        var name = Txt.Make((Doc.Str(d, "name", "") is var n && n != "" ? n : isVst ? Doc.Str(d["p"], "name", "VST3") : spec.Name).ToUpperInvariant(), 10.5, on ? Theme.Ink : Theme.Dim, true);
        name.Margin = new Thickness(6, 0, 4, 0);
        head.Children.Add(name);
        Point down = default;
        head.MouseLeftButtonDown += (_, e) =>
        {
            if (e.ClickCount == 2) { Edit(() => d["fold"] = !fold); e.Handled = true; return; }
            down = e.GetPosition(this);
            sel = id; Focus();
            foreach (var el in chain.Children.OfType<Border>())
                if (el.Tag is string t && t != "drop") { el.BorderBrush = t == id ? col : Theme.Panel3; el.BorderThickness = t == id ? new Thickness(2) : new Thickness(1, 2, 1, 1); }
            e.Handled = true;
        };
        head.MouseMove += (_, e) =>
        {
            if (e.LeftButton != MouseButtonState.Pressed || sel != id) return;
            var p = e.GetPosition(this);
            if (Math.Abs(p.X - down.X) < 6 && Math.Abs(p.Y - down.Y) < 6) return;
            DragDrop.DoDragDrop(head, new DataObject(MoveFmt, id), DragDropEffects.Move);
        };

        if (fold)
        {
            // Piegato: solo una striscia verticale con il nome
            var strip = new DockPanel { Width = 30 };
            var tn = Txt.Make(spec.Name.ToUpperInvariant(), 10.5, Theme.Ink, true);
            tn.LayoutTransform = new RotateTransform(-90);
            tn.HorizontalAlignment = HorizontalAlignment.Center;
            tn.Margin = new Thickness(0, 8, 0, 0);
            var top = new StackPanel();
            pw.Margin = new Thickness(7, 6, 0, 0); pw.HorizontalAlignment = HorizontalAlignment.Left;
            head.Children.Remove(pw);
            top.Children.Add(pw);
            fb.HorizontalAlignment = HorizontalAlignment.Center;
            head.Children.Remove(fb);
            top.Children.Add(fb);
            top.Children.Add(tn);
            top.Cursor = Cursors.SizeAll;
            top.MouseLeftButtonDown += (_, e) => { if (e.ClickCount == 2) Edit(() => d["fold"] = false); };
            b.MinWidth = 0;
            b.Child = top;
            return b;
        }

        var g = KnobGrid();
        var pp = (JsonObject)d["p"]!;
        if (isVst) VstBody(d, g, col);
        else foreach (var p in spec.Params)
        {
            if (p.Kind == "enum")
            {
                var box = new StackPanel { Width = 92, Margin = new Thickness(0, 0, 0, 6) };
                var l = Txt.Make(p.Label, 9.5, Theme.Dim); l.HorizontalAlignment = HorizontalAlignment.Center;
                box.Children.Add(l);
                var dd = new Dropdown(84) { Margin = new Thickness(2, 4, 2, 2) };
                dd.SetItems(p.Options.Select(o => (o.v, o.l)));
                dd.Value = pp[p.K]?.ToString() ?? p.Def?.ToString() ?? "";
                var key = p.K;
                dd.Changed += v => Edit(() => pp[key] = v);
                box.Children.Add(dd);
                g.Children.Add(box);
                continue;
            }
            double def = Doc.Val(p.Def, p.Min);
            var pr = p;
            var kb = new Knob(p.Label, p.Min, p.Max, def, Doc.Num(pp, p.K, def), v => DeviceSpecs.Format(pr, v), p.Log) { Color = col, Integer = p.Unit == "bit", LearnId = $"dev:{Ch}:{Doc.Str(d, "id", "")}:{p.K}" };
            kb.Begin += () => doc.Snapshot();
            kb.Changed += v => { pp[pr.K] = v; doc.CommitQuiet(doc.ChainKey(Ch)); };
            kb.End += () => doc.CommitQuiet(doc.ChainKey(Ch));
            g.Children.Add(kb);
        }
        var body = new StackPanel();
        body.Children.Add(head);
        body.Children.Add(g);
        b.Child = body;
        return b;
    }

    // ------------------------------------------------------------------ plugin VST 3
    void VstBody(JsonObject d, WrapPanel g, Brush col)
    {
        string id = Doc.Str(d, "id", "");
        Vst3.Plugin? plug;
        lock (Vst3.Live) Vst3.Live.TryGetValue(id, out plug);
        if (plug == null)
        {
            var t = Txt.Make($"Plugin non caricato\n{Path.GetFileName(Doc.Str(d["p"], "path", ""))}", 11, Theme.Dim);
            t.Width = 150; t.TextWrapping = TextWrapping.Wrap; t.Margin = new Thickness(4);
            g.Children.Add(t);
            return;
        }
        var ed = new Btn("EDITOR", 84, "Apre la finestra del plugin") { Margin = new Thickness(4, 4, 4, 6) };
        ed.Click += () => Vst3Editor.Open(Window.GetWindow(this), plug, d, () => Capture(d, plug, true));
        g.Children.Add(ed);
        var ps = plug.Params().Where(p => p.Steps == 0 && !p.Name.Contains("Bypass", StringComparison.OrdinalIgnoreCase)).ToList();
        foreach (var p in ps.Take(8))
        {
            var pid = p.Id;
            var kb = new Knob(p.Name.Length > 11 ? p.Name[..11] : p.Name, 0, 1, p.Def, plug.Get(pid), v => plug.Text(pid, v)) { Color = col, LearnId = $"vst:{id}:{pid}", ToolTip = p.Name };
            kb.Begin += () => { Capture(d, plug, false); doc.Snapshot(); };
            kb.Changed += v => plug.Set(pid, v);
            kb.End += () => Capture(d, plug, true);
            g.Children.Add(kb);
        }
        if (ps.Count > 8) g.Children.Add(Txt.Make($"+{ps.Count - 8} parametri\nnell'editor", 10, Theme.Dim));
    }

    /// <summary>Stato del plugin nel progetto (salvataggio, annulla); commit = invia anche al motore e ai dispositivi.</summary>
    void Capture(JsonObject d, Vst3.Plugin plug, bool commit)
    {
        string st = plug.GetState();
        if (st == "") return;
        ((JsonObject)d["p"]!)["state"] = st;
        plug.AppliedState = st;
        if (commit) doc.CommitQuiet(doc.ChainKey(Ch));
    }

    // ------------------------------------------------------------------ modifiche
    void Edit(Action a) { doc.Snapshot(); a(); doc.Commit(doc.ChainKey(Ch)); }
    public void Add(string type, int? at)
    {
        if (Ch < 0) return;
        doc.Snapshot();
        var d = type.StartsWith("vst3\u001f") ? Vst3Device(type) : DeviceSpecs.New(type);
        var c = doc.Chain(Ch);
        c.Insert(Math.Clamp(at ?? c.Count, 0, c.Count), d);
        sel = Doc.Str(d, "id", "");
        doc.Commit(doc.ChainKey(Ch));
    }
    void Remove(string id)
    {
        var c = doc.Chain(Ch);
        var d = c.FirstOrDefault(x => Doc.Str(x, "id", "") == id);
        if (d == null) return;
        doc.Snapshot(); c.Remove(d); sel = null; doc.Commit(doc.ChainKey(Ch));
    }
    void Duplicate(string id)
    {
        var c = doc.Chain(Ch);
        int i = c.Select((x, k) => (x, k)).FirstOrDefault(t => Doc.Str(t.x, "id", "") == id).k;
        if (i < 0 || i >= c.Count) return;
        doc.Snapshot();
        var n = (JsonObject)c[i]!.DeepClone();
        n["id"] = DeviceSpecs.New(Doc.Str(n, "type", "eq"))["id"]!.DeepClone();
        c.Insert(i + 1, n);
        sel = Doc.Str(n, "id", "");
        doc.Commit(doc.ChainKey(Ch));
    }
    void OnKey(object s, KeyEventArgs e)
    {
        if (sel == null || Keyboard.FocusedElement is TextBox) return;
        if (e.Key is Key.Delete or Key.Back) { Remove(sel); e.Handled = true; }
        else if (e.Key == Key.D && Keyboard.Modifiers.HasFlag(ModifierKeys.Control)) { Duplicate(sel); e.Handled = true; }
    }

    // ------------------------------------------------------------------ trascinamento
    /// <summary>Posizione d'inserimento: device con il centro a sinistra del puntatore.</summary>
    int InsertAt(Point p)
    {
        int k = 0;
        foreach (var el in chain.Children.OfType<Border>())
        {
            if (el.Tag is not string t || t == "drop") continue;
            var pos = el.TranslatePoint(new Point(0, 0), chain);
            if (p.X > pos.X + el.ActualWidth / 2) k++;
        }
        return k;
    }
    void OnDragOver(object s, DragEventArgs e)
    {
        e.Effects = e.Data.GetDataPresent(MoveFmt) ? DragDropEffects.Move : e.Data.GetDataPresent(NewFmt) ? DragDropEffects.Copy : DragDropEffects.None;
        e.Handled = true;
    }
    void OnDrop(object s, DragEventArgs e)
    {
        int at = InsertAt(e.GetPosition(chain));
        if (e.Data.GetData(NewFmt) is string type) { Add(type, at); e.Handled = true; return; }
        if (e.Data.GetData(MoveFmt) is not string id) return;
        var c = doc.Chain(Ch);
        var d = c.FirstOrDefault(x => Doc.Str(x, "id", "") == id);
        if (d == null) return;
        int from = c.IndexOf(d);
        doc.Snapshot();
        c.RemoveAt(from);
        c.Insert(Math.Clamp(from < at ? at - 1 : at, 0, c.Count), d);
        doc.Commit(doc.ChainKey(Ch));
        e.Handled = true;
    }
    /// <summary>Device VST 3 da "vst3␟percorso␟cid␟nome" (dati del trascinamento dalla Libreria).</summary>
    static JsonObject Vst3Device(string type)
    {
        var f = type.Split('\u001f');
        var d = DeviceSpecs.New("eq");
        d["type"] = "vst3";
        d["p"] = new JsonObject { ["path"] = f[1], ["cid"] = f[2], ["name"] = f[3] };
        return d;
    }
    public static string Vst3Type(Vst3.PluginInfo p) => $"vst3\u001f{p.Path}\u001f{p.Cid}\u001f{p.Name}";

    /// <summary>Dati per trascinare un nuovo effetto dal browser.</summary>
    public static DataObject NewDeviceData(string type) => new(NewFmt, type);
    public static bool IsNewDevice(IDataObject d, out string type) { type = d.GetData(NewFmt) as string ?? ""; return type != ""; }
}
