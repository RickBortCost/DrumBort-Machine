// MixerView.cs — Mixer a strisce (come il Mixer di Logic e di FL Studio): una striscia per
// traccia (stack, mandate A/B, pan, fader, livello, mute/solo), poi Track Stack, ritorni e master.
// Clic sul nome: la catena di device di quella striscia.

using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using DrumBort.Engine;
using DrumBort.Host;

namespace DrumBort.Win;

public sealed class MixerView : ScrollViewer
{
    readonly Doc doc;
    readonly StackPanel strips = new() { Orientation = Orientation.Horizontal, Margin = new Thickness(6) };
    readonly List<(int id, Meter m)> meters = new();
    public event Action<int>? Pick;
    public int Selected = -1;

    public MixerView(Doc doc)
    {
        this.doc = doc;
        Background = Theme.Panel;
        HorizontalScrollBarVisibility = ScrollBarVisibility.Auto;
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        Content = strips;
    }

    public void Render()
    {
        strips.Children.Clear(); meters.Clear();
        foreach (int ch in doc.Tracks) strips.Children.Add(TrackStrip(ch));
        strips.Children.Add(new Border { Width = 10 });
        for (int s = 0; s < doc.StackList.Count; s++) strips.Children.Add(BusStrip(Doc.StackBase + s));
        strips.Children.Add(BusStrip(Doc.RetA));
        strips.Children.Add(BusStrip(Doc.RetB));
        strips.Children.Add(BusStrip(Doc.MasterBus));
    }

    /// <summary>Livelli dal motore (chiamato dal timer dell'interfaccia).</summary>
    public void UpdateMeters(AudioEngine e)
    {
        foreach (var (id, m) in meters)
            m.Set(id < 12 ? e.Mx.Peaks[id] : id == Doc.MasterBus ? e.Mx.Peaks[Mixer.Channels] : id is Doc.RetA or Doc.RetB ? e.Mx.BusPeaks[id - Doc.RetA] : e.Mx.BusPeaks[2 + id - Doc.StackBase]);
    }

    Border Frame(int id, out StackPanel sp)
    {
        var col = Theme.Track(id);
        var b = new Border
        {
            Width = 92, Margin = new Thickness(0, 0, 4, 0), Background = id == Selected ? Theme.Panel3 : Theme.Panel2,
            BorderBrush = col, BorderThickness = new Thickness(0, 4, 0, 0), CornerRadius = new CornerRadius(3),
        };
        sp = new StackPanel { Margin = new Thickness(4) };
        var name = new Btn(doc.ChShort(id), 0, doc.ChName(id) + " — clic: effetti") { Fg = col, HorizontalAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(0, 0, 0, 2) };
        name.Click += () => Pick?.Invoke(id);
        sp.Children.Add(name);
        var sub = Txt.Make(doc.ChName(id), 9.5, Theme.Dim); sub.TextTrimming = TextTrimming.CharacterEllipsis; sub.ToolTip = doc.ChName(id);
        sp.Children.Add(sub);
        b.Child = sp;
        return b;
    }

    static UIElement Labeled(string label, FrameworkElement el)
    {
        var g = new DockPanel { Margin = new Thickness(0, 2, 0, 0) };
        var l = Txt.Make(label, 9, Theme.Dim); l.Width = 18; l.VerticalAlignment = VerticalAlignment.Center;
        DockPanel.SetDock(l, Dock.Left);
        g.Children.Add(l); g.Children.Add(el);
        return g;
    }

    /// <summary>Fader e livello affiancati, con il valore sotto.</summary>
    UIElement FaderRow(int id, double value, double def, Action<double> set, Action begin, Action end, string learn)
    {
        var col = Theme.Track(id);
        var row = new Grid { Height = 104, Margin = new Thickness(0, 4, 0, 0) };
        row.ColumnDefinitions.Add(new ColumnDefinition());
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(10) });
        var f = new VFader(0, 1, def, value) { Color = col, LearnId = learn, HorizontalAlignment = HorizontalAlignment.Center };
        var val = Txt.Make(Db(value), 10, Theme.Lcd);
        f.Begin += begin;
        f.Changed += v => { set(v); val.Text = Db(v); };
        f.End += end;
        var m = new Meter { Vertical = true, Width = 6, Height = double.NaN, Margin = new Thickness(2, 6, 2, 6) };
        Grid.SetColumn(m, 1);
        row.Children.Add(f); row.Children.Add(m);
        meters.Add((id, m));
        var sp = new StackPanel();
        sp.Children.Add(row);
        val.HorizontalAlignment = HorizontalAlignment.Center;
        sp.Children.Add(val);
        return sp;
    }
    /// <summary>Volume in dB (0,8 = 0 dB come nel motore: guadagno = v² × 1,5625).</summary>
    static string Db(double v) => v <= 0.001 ? "−∞" : (20 * Math.Log10(v * v * 1.5625)).ToString("+0.0;−0.0;0.0", CultureInfo.InvariantCulture);

    UIElement TrackStrip(int ch)
    {
        var b = Frame(ch, out var sp);
        var t = doc.Track(ch);
        var col = Theme.Track(ch);
        // Track Stack
        var dd = new Dropdown(80) { Margin = new Thickness(0, 4, 0, 2), ToolTip = "Track Stack: tracce con un bus comune (effetti e volume di gruppo)" };
        var items = new List<(string, string)> { ("-1", "— stack") };
        for (int s = 0; s < doc.StackList.Count; s++) items.Add((s.ToString(), doc.BusName(Doc.StackBase + s)));
        if (doc.StackList.Count < Mixer.Stacks) items.Add((doc.StackList.Count.ToString(), "＋ nuovo stack"));
        dd.SetItems(items);
        dd.Value = doc.StackOf(ch).ToString();
        dd.Changed += v => { doc.Snapshot(); doc.SetStack(ch, int.Parse(v)); doc.Commit("buses"); };
        sp.Children.Add(dd);
        // Mandate e pan
        HSlider Sl(string k, double min, double def, string learn)
        {
            var h = new HSlider(min, 1, def, Doc.Num(t, k, def)) { Color = col, LearnId = learn, Height = 14 };
            h.Begin += () => doc.Snapshot();
            h.Changed += v => { doc.SetAll(ch, k, v); doc.CommitQuiet(doc.AllPatKeys); };
            h.End += () => doc.Commit(doc.AllPatKeys);
            return h;
        }
        sp.Children.Add(Labeled("A", Sl("rev", 0, 0, $"trk:{ch}:rev")));
        sp.Children.Add(Labeled("B", Sl("dly", 0, 0, $"trk:{ch}:dly")));
        sp.Children.Add(Labeled("◐", Sl("pan", -1, 0, $"trk:{ch}:pan")));
        sp.Children.Add(FaderRow(ch, Doc.Num(t, "vol", 0.8), 0.8, v => { doc.SetAll(ch, "vol", v); doc.CommitQuiet(doc.AllPatKeys); }, doc.Snapshot, () => doc.Commit(doc.AllPatKeys), $"trk:{ch}:vol"));
        bool mute = Doc.Bool(t, "mute"), solo = Doc.Bool(t, "solo");
        var ms = new UniformGrid2();
        var m = new Btn("M", 0, "Mute") { IsOn = mute, Padding = new Thickness(0) };
        var s2 = new Btn("S", 0, "Solo") { IsOn = solo, Padding = new Thickness(0), OnBrush = Theme.SoloBg, OnBorder = Theme.Cyan };
        m.Click += () => { doc.Snapshot(); doc.SetAll(ch, "mute", !mute); doc.Commit(doc.AllPatKeys); };
        s2.Click += () => { doc.Snapshot(); doc.SetAll(ch, "solo", !solo); doc.Commit(doc.AllPatKeys); };
        ms.Add(m, s2);
        sp.Children.Add(ms);
        return b;
    }

    UIElement BusStrip(int id)
    {
        var b = Frame(id, out var sp);
        var fx = (JsonObject)(doc.Root["fx"] ??= new JsonObject());
        if (id >= Doc.StackBase)
        {
            var st = (JsonObject)doc.StackList[id - Doc.StackBase]!;
            int n = (st["tracks"] as JsonArray)?.Count ?? 0;
            sp.Children.Add(Txt.Make($"{n} tracce", 10, Theme.Dim));
            sp.Children.Add(new Border { Height = 48 });
            sp.Children.Add(FaderRow(id, Doc.Num(st, "vol", 0.8), 0.8, v => { st["vol"] = v; doc.CommitQuiet("buses"); }, doc.Snapshot, () => doc.Commit("buses"), $"stack:{id - Doc.StackBase}:vol"));
            bool mute = Doc.Bool(st, "mute");
            var m = new Btn("M", 0, "Mute dello stack") { IsOn = mute, HorizontalAlignment = HorizontalAlignment.Stretch };
            m.Click += () => { doc.Snapshot(); st["mute"] = !mute; doc.Commit("buses"); };
            sp.Children.Add(m);
            return b;
        }
        string k = id == Doc.RetA ? "rev" : id == Doc.RetB ? "dly" : "master";
        double def = id == Doc.RetA ? 0.8 : id == Doc.RetB ? 0.7 : 0.8;
        sp.Children.Add(Txt.Make(id == Doc.MasterBus ? "uscita" : "ritorno", 10, Theme.Dim));
        sp.Children.Add(new Border { Height = 48 });
        sp.Children.Add(FaderRow(id, Doc.Num(fx, k, def), def, v => { fx[k] = v; doc.CommitQuiet("fx"); }, doc.Snapshot, () => doc.Commit("fx"), $"fx:{k}"));
        return b;
    }
}

/// <summary>Due pulsanti affiancati della stessa larghezza.</summary>
public sealed class UniformGrid2 : Grid
{
    public UniformGrid2() { ColumnDefinitions.Add(new ColumnDefinition()); ColumnDefinitions.Add(new ColumnDefinition()); Margin = new Thickness(0, 2, 0, 0); }
    public void Add(UIElement a, UIElement b) { SetColumn(b, 1); Children.Add(a); Children.Add(b); }
}
