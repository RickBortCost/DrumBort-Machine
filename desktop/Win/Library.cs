// Library.cs — Libreria a sinistra (come in Logic Pro): suoni per la traccia synth selezionata,
// kit e voci per la batteria, effetti audio da trascinare nella catena.

using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using DrumBort.Engine;

namespace DrumBort.Win;

public sealed class Library : DockPanel
{
    sealed record PresetInfo(string Id, string Name, string Cat, string Tags);
    static List<PresetInfo>? presets;
    readonly Doc doc;
    readonly StackPanel tabs = new() { Orientation = Orientation.Horizontal };
    readonly WrapPanel cats = new() { Margin = new Thickness(4, 2, 4, 2) };
    readonly StackPanel list = new();
    readonly TextBox search = new() { Margin = new Thickness(6, 4, 6, 4), Padding = new Thickness(4), Background = Theme.Dark, Foreground = Theme.Ink, BorderBrush = Theme.Edge, CaretBrush = Theme.Ink, FontSize = 13 };
    readonly TextBlock head = Txt.Make("", 11, Theme.Dim);
    string tab = "sounds", cat = "";
    public Func<int> Selected = () => -1;
    public Action<string>? AddDevice;

    public Library(Doc doc)
    {
        this.doc = doc;
        Background = Theme.Panel;
        presets ??= LoadPresets();
        var title = Txt.Make("LIBRERIA", 11, Theme.Dim, true); title.Margin = new Thickness(8, 6, 8, 2);
        DockPanel.SetDock(title, Dock.Top); Children.Add(title);
        foreach (var (k, l) in new[] { ("sounds", "SUONI"), ("kits", "KIT"), ("fx", "EFFETTI") })
        {
            var b = new Btn(l, 64) { Tag = k };
            b.Click += () => { tab = k; cat = ""; Render(); };
            tabs.Children.Add(b);
        }
        tabs.Margin = new Thickness(4, 0, 4, 0);
        DockPanel.SetDock(tabs, Dock.Top); Children.Add(tabs);
        DockPanel.SetDock(search, Dock.Top); Children.Add(search);
        search.TextChanged += (_, _) => Render();
        head.Margin = new Thickness(8, 2, 8, 2); head.TextWrapping = TextWrapping.Wrap;
        DockPanel.SetDock(head, Dock.Top); Children.Add(head);
        DockPanel.SetDock(cats, Dock.Top); Children.Add(cats);
        Children.Add(new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
    }

    static List<PresetInfo> LoadPresets()
    {
        var o = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Assets", "presets.json")))!.AsObject();
        return o.Select(kv => new PresetInfo(kv.Key, Doc.Str(kv.Value, "name", kv.Key), Doc.Str(kv.Value, "cat", ""),
            kv.Value?["tags"] is JsonArray t ? string.Join(" ", t.Select(x => x?.ToString())) : "")).ToList();
    }

    /// <summary>Apre la scheda adatta alla traccia (synth → suoni, batteria → kit e voci).</summary>
    public void ShowFor(int ch) { tab = Doc.IsSynth(ch) ? "sounds" : "kits"; cat = ""; search.Text = ""; Render(); }
    public void ShowEffects() { tab = "fx"; Render(); }

    static Border Item(string title, string sub, bool current)
    {
        var sp = new StackPanel { Margin = new Thickness(8, 4, 8, 4) };
        sp.Children.Add(Txt.Make(title, 13, Theme.Ink));
        if (sub != "") sp.Children.Add(Txt.Make(sub, 10.5, Theme.Dim));
        var b = new Border { Child = sp, Background = current ? Theme.OnBg : Theme.Panel2, BorderBrush = current ? Theme.Orange : Theme.Panel3, BorderThickness = new Thickness(current ? 3 : 0, 0, 0, 1), Cursor = Cursors.Hand, Margin = new Thickness(4, 1, 4, 1) };
        b.MouseEnter += (_, _) => { if (!current) b.Background = Theme.Hover; };
        b.MouseLeave += (_, _) => { if (!current) b.Background = Theme.Panel2; };
        return b;
    }
    static TextBlock Sep(string t) { var s = Txt.Make(t, 10, Theme.Dim, true); s.Margin = new Thickness(8, 8, 8, 2); return s; }

    public void Render()
    {
        foreach (Btn b in tabs.Children) b.IsOn = (string)b.Tag == tab;
        list.Children.Clear(); cats.Children.Clear();
        string q = search.Text.Trim().ToLowerInvariant();
        int ch = Selected();
        if (tab == "sounds")
        {
            int k = ch >= 8 ? ch - 8 : -1;
            head.Text = k >= 0 ? $"Suono per {Doc.SynthNames[k]}: clic per sceglierlo" : "Seleziona una traccia synth per assegnare un suono (clic = ascolto).";
            var catList = presets!.Select(p => p.Cat).Where(c => c != "").Distinct().ToList();
            foreach (var c in new[] { "" }.Concat(catList))
            {
                var b = new Btn(c == "" ? "Tutti" : c) { IsOn = c == cat, MinHeight = 22, Padding = new Thickness(6, 0, 6, 0) };
                var cc = c;
                b.Click += () => { cat = cc; Render(); };
                cats.Children.Add(b);
            }
            string cur = k >= 0 ? Doc.Str(doc.Track(ch), "preset", "") : "";
            foreach (var p in presets!.Where(p => (q == "" ? cat == "" || p.Cat == cat : (p.Name + " " + p.Cat + " " + p.Tags).ToLowerInvariant().Contains(q))))
            {
                var it = Item(p.Name, p.Cat, p.Id == cur);
                var pid = p.Id;
                it.MouseLeftButtonUp += (_, _) => PickPreset(pid);
                list.Children.Add(it);
            }
        }
        else if (tab == "kits")
        {
            head.Text = "Kit del pattern corrente; voci: clic per ascoltare.";
            string cur = Doc.Str(doc.Pat, "kit", "");
            foreach (var kit in Kits.All.Where(x => q == "" || x.Name.ToLowerInvariant().Contains(q)))
            {
                var it = Item(kit.Name, kit.Group ?? "kit", kit.Id == cur);
                var kid = kit.Id;
                it.MouseLeftButtonUp += (_, _) => PickKit(kid);
                list.Children.Add(it);
            }
            if (ch >= 0 && ch < 8)
            {
                list.Children.Add(Sep($"VOCE {doc.Kit.Tracks[ch].Name.ToUpperInvariant()}"));
                var it = Item("▶ Ascolta", doc.Kit.Name, false);
                int c2 = ch;
                it.MouseLeftButtonUp += (_, _) => doc.PreviewDrum(c2);
                list.Children.Add(it);
            }
        }
        else
        {
            head.Text = ch >= 0 ? $"Trascina un effetto nella catena in basso; doppio clic: aggiungi a {doc.TrackShort(ch)}." : "Seleziona una traccia, poi trascina o fai doppio clic su un effetto.";
            foreach (var c in DeviceSpecs.Categories)
            {
                var items = DeviceSpecs.All.Where(d => d.Cat == c && (q == "" || (d.Name + " " + d.Desc).ToLowerInvariant().Contains(q))).ToList();
                if (items.Count == 0) continue;
                list.Children.Add(Sep(c.ToUpperInvariant()));
                foreach (var d in items)
                {
                    var it = Item(d.Name, d.Desc, false);
                    it.ToolTip = d.Desc;
                    string type = d.Type;
                    Point down = default; bool pressed = false;
                    it.MouseLeftButtonDown += (_, e) =>
                    {
                        if (e.ClickCount == 2) { AddDevice?.Invoke(type); pressed = false; return; }
                        down = e.GetPosition(this); pressed = true;
                    };
                    it.MouseLeftButtonUp += (_, _) => pressed = false;
                    it.MouseMove += (_, e) =>
                    {
                        if (!pressed || e.LeftButton != MouseButtonState.Pressed) return;
                        var p = e.GetPosition(this);
                        if (Math.Abs(p.X - down.X) + Math.Abs(p.Y - down.Y) < 8) return;
                        pressed = false;
                        DragDrop.DoDragDrop(it, DeviceView.NewDeviceData(type), DragDropEffects.Copy);
                    };
                    list.Children.Add(it);
                }
            }
        }
    }

    void PickPreset(string id)
    {
        int ch = Selected();
        if (ch < 8) { doc.Op("prev", new JsonObject { ["k"] = 0, ["notes"] = new JsonArray(45) }); return; }
        int k = ch - 8;
        doc.Snapshot();
        for (int i = 0; i < Doc.Slots; i++)
        {
            var t = Doc.TrackOf(doc.PatAt(i), ch);
            t["preset"] = id;
            t.Remove("patch");
        }
        doc.Commit(doc.AllPatKeys);
        int b = doc.Base(k);
        doc.PreviewSynth(k, b);
    }

    void PickKit(string id)
    {
        doc.Snapshot();
        var p = doc.Pat;
        p["kit"] = id;
        var kit = Kits.ById(id);
        for (int i = 0; i < 8; i++) ((JsonObject)p["tracks"]![i]!)["pan"] = kit.Tracks[i].Pan;
        doc.Commit(doc.PatKey);
        int ch = Selected();
        doc.PreviewDrum(ch >= 0 && ch < 8 ? ch : 0);
    }
}
