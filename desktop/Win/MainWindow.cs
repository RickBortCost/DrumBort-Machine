// MainWindow.cs — Finestra principale di DrumBort per Windows.
//
//   ┌ trasporto: play, BPM, swing, pattern, battute, kit, metronomo, posizione, file, audio, telefono ┐
//   │ Libreria │ tracce (colore, nome, M/S, volume, pan, livello) │ step della traccia               │
//   │          ├──────────────────────────────────────────────────────────────────────────────────┤
//   │          │ in basso: DEVICE (catena di effetti) o NOTE (piano roll delle tracce synth)       │
//   └──────────┴──────────────────────────────────────────────────────────────────────────────────┘

using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using DrumBort.Engine;
using DrumBort.Host;
using Microsoft.Win32;

namespace DrumBort.Win;

public sealed class MainWindow : Window
{
    readonly Doc doc;
    readonly Library library;
    readonly DeviceView devices;
    readonly StackPanel heads = new(), rows = new();
    readonly ContentControl bottomHost = new();
    readonly Grid root = new();
    readonly ColumnDefinition libCol = new() { Width = new GridLength(250) };
    readonly RowDefinition bottomRow = new() { Height = new GridLength(300) };
    readonly List<StepRow> stepRows = new();
    readonly List<(int ch, Meter m)> meters = new();
    readonly Meter masterMeter = new() { Width = 120, Height = 6 };
    PianoRoll? roll;
    int sel = -1;
    string bottom = "dev";
    bool libOpen = true;
    readonly string? selftest;

    // Trasporto
    readonly Btn play = new("▶", 44, "Play / Stop (Spazio)");
    readonly TextBlock bpm = Txt.Make("120", 20, Theme.Lcd, true), pos = Txt.Make("1.1.1", 18, Theme.Lcd, true);
    readonly HSlider swing = new(50, 75, 50, 50) { Width = 110 };
    readonly TextBlock swingTxt = Txt.Make("50 %", 12, Theme.Lcd);
    readonly Dropdown slotDd = new(64), barsDd = new(70), kitDd = new(190);
    readonly Btn met = new("MET", 0, "Metronomo"), undoB = new("↶", 0, "Annulla (Ctrl+Z)"), redoB = new("↷", 0, "Ripeti (Ctrl+Y)");
    readonly Btn libB = new("◧", 0, "Mostra/nascondi la Libreria (B)"), devTab = new("DEVICE"), rollTab = new("NOTE");
    bool metOn;

    public MainWindow(string? selftest)
    {
        this.selftest = selftest;
        Title = $"DrumBort Machine {typeof(MainWindow).Assembly.GetName().Version?.ToString(3)}";
        Width = 1440; Height = 900; MinWidth = 1000; MinHeight = 640;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = Theme.Bg; Foreground = Theme.Ink; FontFamily = Theme.Font;

        DeviceSpecs.Load(Path.Combine(AppContext.BaseDirectory, "Assets", "devices.json"));
        doc = new Doc(Program.Hub, Program.DataDir);
        library = new Library(doc) { Selected = () => sel };
        devices = new DeviceView(doc) { OpenLibrary = OpenLibraryFor, ShowNotes = () => SetBottom("roll") };
        library.AddDevice = t => { if (sel >= 0) { devices.Add(t, null); SetBottom("dev"); } };

        BuildLayout();
        doc.Changed += Refresh;
        Program.Hub.RemoteState += parts => Dispatcher.BeginInvoke(() => doc.ApplyRemote(parts));
        Program.Hub.RemoteOp += op => Dispatcher.BeginInvoke(() => { if (Doc.Str(op, "op", "") == "met") { metOn = Doc.Bool(op, "on"); met.IsOn = metOn; } });

        if (selftest != null) DemoContent(); else doc.LoadLast();
        if (sel < 0 && doc.Tracks.Count > 0) sel = doc.Tracks[0];
        Refresh();

        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(33) };
        timer.Tick += (_, _) => Tick();
        timer.Start();
        PreviewKeyDown += OnKey;
        Closing += (_, _) => doc.SaveAuto();
        if (selftest != null) Loaded += (_, _) => Dispatcher.BeginInvoke(SelfTest, DispatcherPriority.ApplicationIdle);
    }

    // ------------------------------------------------------------------ layout
    void BuildLayout()
    {
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star), MinHeight = 120 });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(5) });
        root.RowDefinitions.Add(bottomRow);
        root.ColumnDefinitions.Add(libCol);
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(5) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var bar = Transport();
        Grid.SetColumnSpan(bar, 3);
        root.Children.Add(bar);

        Grid.SetRow(library, 1); Grid.SetRowSpan(library, 3);
        root.Children.Add(library);
        var vs = new GridSplitter { Width = 5, HorizontalAlignment = HorizontalAlignment.Stretch, Background = Theme.Bg, ResizeDirection = GridResizeDirection.Columns };
        Grid.SetRow(vs, 1); Grid.SetRowSpan(vs, 3); Grid.SetColumn(vs, 1);
        root.Children.Add(vs);

        // Tracce: intestazioni + step, scorrimento verticale comune
        var tracksGrid = new Grid();
        tracksGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(270) });
        tracksGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        Grid.SetColumn(rows, 1);
        rows.Margin = new Thickness(6, 0, 8, 0);
        tracksGrid.Children.Add(heads); tracksGrid.Children.Add(rows);
        var top = new DockPanel { Background = Theme.Panel };
        top.Children.Add(TracksToolbar());
        var sv = new ScrollViewer { Content = tracksGrid, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Background = Theme.Bg };
        sv.MouseDoubleClick += (_, e) => { if (e.OriginalSource == sv || e.OriginalSource is Grid) NewTracks(); };
        top.Children.Add(sv);
        Grid.SetRow(top, 1); Grid.SetColumn(top, 2);
        root.Children.Add(top);

        var hs = new GridSplitter { Height = 5, HorizontalAlignment = HorizontalAlignment.Stretch, Background = Theme.Orange, ResizeDirection = GridResizeDirection.Rows, ToolTip = "Trascina per ridimensionare" };
        Grid.SetRow(hs, 2); Grid.SetColumn(hs, 2);
        root.Children.Add(hs);
        Grid.SetRow(bottomHost, 3); Grid.SetColumn(bottomHost, 2);
        root.Children.Add(bottomHost);
        Content = root;
    }

    UIElement TracksToolbar()
    {
        var tb = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(6, 4, 6, 4) };
        DockPanel.SetDock(tb, Dock.Top);
        var add = new Btn("＋ TRACCIA", 0, "Nuove tracce (Ctrl+Alt+N)") { Fg = Theme.Green };
        add.Click += NewTracks;
        tb.Children.Add(add);
        libB.Click += ToggleLibrary;
        tb.Children.Add(libB);
        tb.Children.Add(new Border { Width = 16 });
        devTab.Click += () => SetBottom("dev"); rollTab.Click += () => SetBottom("roll");
        tb.Children.Add(Txt.Make("IN BASSO", 10, Theme.Dim));
        tb.Children.Add(devTab); tb.Children.Add(rollTab);
        tb.Children.Add(new Border { Width = 16 });
        var web = new Btn("INTERFACCIA COMPLETA", 0, "Session, arrangiamento, automazioni, macro, editor wavetable: interfaccia completa in una finestra a parte");
        web.Click += () => { if (Program.Web != null) Launcher.Open($"http://localhost:{Program.Port}/"); };
        tb.Children.Add(web);
        return tb;
    }

    UIElement Transport()
    {
        var b = new Border { Background = Theme.Panel, BorderBrush = Theme.Bg, BorderThickness = new Thickness(0, 0, 0, 3), Padding = new Thickness(6, 4, 6, 4) };
        var sp = new WrapPanel { Orientation = Orientation.Horizontal };
        play.Fg = Theme.Green;
        play.Click += TogglePlay;
        sp.Children.Add(play);

        // BPM: − / valore (rotella, trascinamento) / +
        var minus = new Btn("−", 30); minus.Click += () => SetBpm(Bpm - 1);
        var plus = new Btn("+", 30); plus.Click += () => SetBpm(Bpm + 1);
        var bpmBox = new Border { Background = Theme.Dark, CornerRadius = new CornerRadius(3), Padding = new Thickness(10, 0, 10, 0), Margin = new Thickness(2), Cursor = Cursors.SizeNS, ToolTip = "BPM: rotella o trascina in verticale" };
        var bpmSp = new StackPanel(); bpmSp.Children.Add(bpm); var bl = Txt.Make("BPM", 8, Theme.Dim); bl.HorizontalAlignment = HorizontalAlignment.Center; bpmSp.Children.Add(bl);
        bpmBox.Child = bpmSp;
        double dragY = 0; int dragB = 0; bool dragging = false;
        bpmBox.MouseWheel += (_, e) => SetBpm(Bpm + Math.Sign(e.Delta));
        bpmBox.MouseLeftButtonDown += (_, e) => { dragging = true; dragY = e.GetPosition(this).Y; dragB = Bpm; bpmBox.CaptureMouse(); doc.Snapshot(); };
        bpmBox.MouseMove += (_, e) => { if (dragging) SetBpm(dragB + (int)((dragY - e.GetPosition(this).Y) / 3), false); };
        bpmBox.MouseLeftButtonUp += (_, _) => { if (dragging) { dragging = false; bpmBox.ReleaseMouseCapture(); doc.Commit(doc.PatKey); } };
        sp.Children.Add(minus); sp.Children.Add(bpmBox); sp.Children.Add(plus);

        var posBox = new Border { Background = Theme.Dark, CornerRadius = new CornerRadius(3), Padding = new Thickness(10, 0, 10, 0), Margin = new Thickness(6, 2, 2, 2) };
        var posSp = new StackPanel(); posSp.Children.Add(pos); var pl = Txt.Make("BAR · BEAT · STEP", 8, Theme.Dim); pl.HorizontalAlignment = HorizontalAlignment.Center; posSp.Children.Add(pl);
        posBox.Child = posSp;
        sp.Children.Add(posBox);

        var sw = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(8, 0, 4, 0) };
        sw.Children.Add(Txt.Make("SWING", 10, Theme.Dim)); swing.Margin = new Thickness(6, 0, 6, 0); sw.Children.Add(swing); sw.Children.Add(swingTxt);
        swing.Begin += () => doc.Snapshot();
        swing.Changed += v => { doc.Pat["swing"] = (int)Math.Round(v); swingTxt.Text = $"{(int)Math.Round(v)} %"; doc.CommitQuiet(doc.PatKey); };
        swing.End += () => doc.Commit(doc.PatKey);
        sp.Children.Add(sw);

        slotDd.SetItems(Enumerable.Range(0, Doc.Slots).Select(i => (i.ToString(), $"P{i + 1}")));
        slotDd.ToolTip = "Pattern";
        slotDd.Changed += v => { doc.Slot = int.Parse(v); doc.Commit("slot"); };
        sp.Children.Add(slotDd);
        barsDd.SetItems(new[] { ("1", "1 BAR"), ("2", "2 BAR"), ("4", "4 BAR") });
        barsDd.ToolTip = "Lunghezza del pattern";
        barsDd.Changed += v => { doc.Snapshot(); doc.SetBars(int.Parse(v)); doc.Commit(doc.PatKey); };
        sp.Children.Add(barsDd);
        kitDd.ToolTip = "Kit del pattern";
        kitDd.Changed += v =>
        {
            doc.Snapshot();
            doc.Pat["kit"] = v;
            var kit = Kits.ById(v);
            for (int i = 0; i < 8; i++) ((JsonObject)doc.Pat["tracks"]![i]!)["pan"] = kit.Tracks[i].Pan;
            doc.Commit(doc.PatKey);
        };
        sp.Children.Add(kitDd);
        met.Click += () => { metOn = !metOn; met.IsOn = metOn; doc.Op("met", new JsonObject { ["on"] = metOn }); };
        sp.Children.Add(met);

        undoB.Click += doc.Undo; redoB.Click += doc.Redo;
        sp.Children.Add(new Border { Width = 10 });
        sp.Children.Add(undoB); sp.Children.Add(redoB);
        var file = new Btn("FILE ▾", 0, "Nuovo, apri, salva");
        file.Click += () => Menu.Show(file, new (string, Action?)[]
        {
            ("Nuovo progetto", () => { if (MessageBox.Show(this, "Nuovo progetto vuoto? Quello attuale resta annullabile con Ctrl+Z.", "DrumBort", MessageBoxButton.OKCancel) == MessageBoxResult.OK) { doc.New(); sel = -1; } }),
            ("Apri…  (Ctrl+O)", OpenFile),
            ("Salva con nome…  (Ctrl+S)", SaveFile),
        });
        sp.Children.Add(file);
        var audio = new Btn("🎧 AUDIO", 0, "Uscita audio: cuffie, casse, scheda");
        audio.Click += () => new AudioDialog(this).ShowDialog();
        var phone = new Btn("📱 TELEFONO", 0, "Collega il telefono (QR code)");
        phone.Click += () => new PhoneDialog(this).ShowDialog();
        sp.Children.Add(audio); sp.Children.Add(phone);
        var mm = new StackPanel { Margin = new Thickness(10, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        mm.Children.Add(Txt.Make("MASTER", 9, Theme.Dim)); mm.Children.Add(masterMeter);
        sp.Children.Add(mm);
        b.Child = sp;
        return b;
    }

    // ------------------------------------------------------------------ aggiornamento
    int Bpm => (int)Doc.Num(doc.Pat, "bpm", 120);
    void SetBpm(int v, bool commit = true)
    {
        v = Math.Clamp(v, 40, 240);
        if (commit) doc.Snapshot();
        doc.Pat["bpm"] = v;
        bpm.Text = v.ToString(CultureInfo.InvariantCulture);
        if (commit) doc.Commit(doc.PatKey); else doc.CommitQuiet(doc.PatKey);
    }

    void Refresh()
    {
        if (sel >= 0 && !doc.Tracks.Contains(sel)) sel = doc.Tracks.Count > 0 ? doc.Tracks[0] : -1;
        bpm.Text = Bpm.ToString(CultureInfo.InvariantCulture);
        int sw = (int)Doc.Num(doc.Pat, "swing", 50);
        swing.Set(sw); swingTxt.Text = $"{sw} %";
        slotDd.Value = doc.Slot.ToString();
        barsDd.Value = doc.Bars.ToString();
        kitDd.SetItems(Kits.All.Select(k => (k.Id, k.Name)));
        kitDd.Value = Doc.Str(doc.Pat, "kit", Kits.All[0].Id);
        undoB.Enabled = doc.CanUndo; redoB.Enabled = doc.CanRedo;
        libB.IsOn = libOpen;
        BuildTracks();
        library.Render();
        RenderBottom();
    }

    void BuildTracks()
    {
        heads.Children.Clear(); rows.Children.Clear(); stepRows.Clear(); meters.Clear(); headerOf.Clear();
        var tracks = doc.Tracks;
        if (tracks.Count == 0)
        {
            var t = Txt.Make("Nessuna traccia. Premi ＋ TRACCIA (Ctrl+Alt+N) o fai doppio clic qui: strumento software, voce di batteria o kit completo.", 14, Theme.Dim);
            t.Margin = new Thickness(16); t.TextWrapping = TextWrapping.Wrap;
            heads.Children.Add(new Border { Height = 80 });
            Grid.SetColumnSpan(t, 2);
            rows.Children.Add(t);
            return;
        }
        foreach (int ch in tracks)
        {
            heads.Children.Add(TrackHeader(ch));
            var row = new StepRow(doc, ch) { Margin = new Thickness(0, 2, 0, 2), Height = 44 };
            row.PreviewMouseLeftButtonDown += (_, _) => { if (sel != ch) Select(ch, false, false); };
            stepRows.Add(row);
            rows.Children.Add(row);
        }
    }

    readonly Dictionary<int, Border> headerOf = new();
    UIElement TrackHeader(int ch)
    {
        var t = doc.Track(ch);
        var col = Theme.Track(ch);
        var b = new Border { Height = 48, Margin = new Thickness(0, 0, 0, 0), BorderBrush = col, BorderThickness = new Thickness(5, 0, 0, 1), Background = ch == sel ? Theme.Panel3 : Theme.Panel2, Cursor = Cursors.Hand };
        headerOf[ch] = b;
        var g = new Grid { Margin = new Thickness(6, 2, 4, 2) };
        g.RowDefinitions.Add(new RowDefinition { Height = new GridLength(24) });
        g.RowDefinitions.Add(new RowDefinition { Height = new GridLength(18) });
        var top = new DockPanel();
        var x = new Btn("×", 0, "Togli la traccia") { Padding = new Thickness(5, 0, 5, 0), MinHeight = 20, Margin = new Thickness(1) };
        x.Click += () => RemoveTrack(ch);
        bool mute = Doc.Bool(t, "mute"), solo = Doc.Bool(t, "solo");
        var m = new Btn("M", 24, "Mute") { IsOn = mute, Padding = new Thickness(0), MinHeight = 20, Margin = new Thickness(1) };
        var s = new Btn("S", 24, "Solo") { IsOn = solo, Padding = new Thickness(0), MinHeight = 20, Margin = new Thickness(1), OnBrush = Theme.SoloBg, OnBorder = Theme.Cyan };
        m.Click += () => { doc.Snapshot(); doc.SetAll(ch, "mute", !mute); doc.Commit(doc.AllPatKeys); };
        s.Click += () => { doc.Snapshot(); doc.SetAll(ch, "solo", !solo); doc.Commit(doc.AllPatKeys); };
        foreach (var bt in new[] { x, s, m }) { DockPanel.SetDock(bt, Dock.Right); top.Children.Add(bt); }
        var nm = new StackPanel { Orientation = Orientation.Horizontal };
        nm.Children.Add(Txt.Make(doc.TrackShort(ch), 13, col, true));
        var full = Txt.Make(" " + doc.TrackName(ch), 11, Theme.Dim); full.MaxWidth = 140;
        nm.Children.Add(full);
        top.Children.Add(nm);
        g.Children.Add(top);

        // Volume, livello, pan
        var mix = new Grid();
        mix.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        mix.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(30) });
        mix.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(56) });
        var vol = new HSlider(0, 1, 0.8, Doc.Num(t, "vol", 0.8)) { Color = col, ToolTip = "Volume (doppio clic: 80)" };
        var volT = Txt.Make(Math.Round(Doc.Num(t, "vol", 0.8) * 100).ToString(CultureInfo.InvariantCulture), 10, Theme.Lcd);
        volT.HorizontalAlignment = HorizontalAlignment.Right;
        var pan = new HSlider(-1, 1, 0, Doc.Num(t, "pan", 0)) { Color = col, Margin = new Thickness(6, 0, 0, 0), ToolTip = "Pan (doppio clic: centro)" };
        vol.Begin += () => doc.Snapshot(); pan.Begin += () => doc.Snapshot();
        vol.Changed += v => { doc.SetAll(ch, "vol", v); volT.Text = Math.Round(v * 100).ToString(CultureInfo.InvariantCulture); doc.CommitQuiet(doc.AllPatKeys); };
        pan.Changed += v => { doc.SetAll(ch, "pan", v); doc.CommitQuiet(doc.AllPatKeys); };
        Grid.SetColumn(volT, 1); Grid.SetColumn(pan, 2);
        mix.Children.Add(vol); mix.Children.Add(volT); mix.Children.Add(pan);
        var meter = new Meter { VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 0, 0) };
        Grid.SetColumnSpan(meter, 2);
        mix.Children.Add(meter);
        meters.Add((ch, meter));
        Grid.SetRow(mix, 1);
        g.Children.Add(mix);
        b.Child = g;
        b.MouseLeftButtonDown += (_, e) =>
        {
            if (e.OriginalSource is HSlider) return;
            if (e.ClickCount == 2) { OpenLibraryFor(ch); return; }
            Select(ch, true, true);
        };
        b.AllowDrop = true;
        b.DragOver += (_, e) => { e.Effects = DeviceView.IsNewDevice(e.Data, out string _t) ? DragDropEffects.Copy : DragDropEffects.None; e.Handled = true; };
        b.Drop += (_, e) => { if (DeviceView.IsNewDevice(e.Data, out var type)) { Select(ch, true, false); devices.Add(type, null); } };
        return b;
    }

    /// <summary>Seleziona la traccia: intestazione evidenziata, Libreria e pannello in basso aggiornati.</summary>
    void Select(int ch, bool showDevices, bool preview)
    {
        sel = ch;
        if (showDevices) bottom = "dev";
        else if (Doc.IsSynth(ch)) bottom = "roll";
        if (preview) { if (Doc.IsSynth(ch)) doc.PreviewSynth(ch - 8, doc.Base(ch - 8)); else doc.PreviewDrum(ch); }
        foreach (var (c, h) in headerOf) h.Background = c == sel ? Theme.Panel3 : Theme.Panel2;
        library.Render();
        RenderBottom();
    }

    void SetBottom(string m) { bottom = m; RenderBottom(); }

    void RenderBottom()
    {
        devTab.IsOn = bottom == "dev"; rollTab.IsOn = bottom == "roll";
        if (bottom == "roll" && sel >= 8)
        {
            if (roll != null && roll.Ch == sel && bottomHost.Content is ScrollViewer cur && cur.Content == roll) { roll.InvalidateVisual(); return; }
            roll = new PianoRoll(doc, sel);
            bottomHost.Content = new ScrollViewer { Content = roll, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Background = Theme.Bg };
            roll.Loaded += (_, _) => ((ScrollViewer)bottomHost.Content).ScrollToVerticalOffset(roll.Height / 2 - 120);
            return;
        }
        roll = null;
        if (bottom == "roll")
        {
            var t = Txt.Make(sel >= 0 ? "Traccia di batteria: le note si scrivono negli step qui sopra (clic, Shift o tasto destro = accento)." : "Seleziona una traccia synth per il piano roll.", 13, Theme.Dim);
            t.Margin = new Thickness(16);
            bottomHost.Content = new Border { Background = Theme.Panel, Child = t };
            return;
        }
        devices.Ch = sel;
        devices.Render();
        bottomHost.Content = devices;
    }

    // ------------------------------------------------------------------ tracce
    void NewTracks()
    {
        var d = new NewTrackDialog(this, doc);
        if (d.ShowDialog() != true || d.Result.Count == 0) return;
        doc.Snapshot();
        doc.SetTracks(doc.Tracks.Concat(d.Result));
        foreach (int ch in d.Result) doc.SetAll(ch, "mute", false);
        sel = d.Result[0];
        doc.Commit(new[] { "tracks" }.Concat(doc.AllPatKeys).ToArray());
        if (d.OpenLibrary) OpenLibraryFor(sel);
    }
    void RemoveTrack(int ch)
    {
        if (MessageBox.Show(this, $"Togliere la traccia {doc.TrackShort(ch)}? Le note restano nei pattern, la traccia viene silenziata.", "DrumBort", MessageBoxButton.OKCancel) != MessageBoxResult.OK) return;
        doc.Snapshot();
        doc.SetTracks(doc.Tracks.Where(x => x != ch));
        doc.SetAll(ch, "mute", true);
        doc.Commit(new[] { "tracks" }.Concat(doc.AllPatKeys).ToArray());
    }
    void OpenLibraryFor(int ch)
    {
        sel = ch;
        if (!libOpen) ToggleLibrary();
        library.ShowFor(ch);
        foreach (var (c, h) in headerOf) h.Background = c == sel ? Theme.Panel3 : Theme.Panel2;
        RenderBottom();
    }
    void ToggleLibrary()
    {
        libOpen = !libOpen;
        libCol.Width = new GridLength(libOpen ? 250 : 0);
        library.Visibility = libOpen ? Visibility.Visible : Visibility.Collapsed;
        libB.IsOn = libOpen;
    }

    // ------------------------------------------------------------------ trasporto e misuratori
    void TogglePlay()
    {
        bool playing = Program.Engine?.Seq.Playing ?? false;
        doc.Op(playing ? "stop" : "play");
    }
    void Tick()
    {
        var e = Program.Engine;
        if (e == null) return;
        bool playing = e.Seq.Playing;
        play.Text = playing ? "■" : "▶";
        play.IsOn = playing;
        int n = doc.StepCount;
        int step = playing ? (int)(e.Seq.Tick % n) : -1;
        foreach (var r in stepRows) if (r.Playhead != step) { r.Playhead = step; r.InvalidateVisual(); }
        if (roll != null && roll.Playhead != step) { roll.Playhead = step; roll.InvalidateVisual(); }
        if (playing) pos.Text = $"{step / 16 + 1}.{step % 16 / 4 + 1}.{step % 4 + 1}";
        var pk = e.Mx.Peaks;
        foreach (var (ch, m) in meters) m.Set(pk[ch]);
        masterMeter.Set(pk[Mixer.Channels]);
    }

    // ------------------------------------------------------------------ file
    void OpenFile()
    {
        var d = new OpenFileDialog { Filter = "Progetti DrumBort (*.json)|*.json|Tutti i file|*.*" };
        if (d.ShowDialog(this) != true) return;
        try { doc.Open(d.FileName); sel = doc.Tracks.Count > 0 ? doc.Tracks[0] : -1; Refresh(); }
        catch (Exception x) { MessageBox.Show(this, x.Message, "Apri progetto", MessageBoxButton.OK, MessageBoxImage.Error); }
    }
    void SaveFile()
    {
        var d = new SaveFileDialog { Filter = "Progetti DrumBort (*.json)|*.json", FileName = doc.FilePath != null ? Path.GetFileName(doc.FilePath) : "progetto.drumbort.json" };
        if (d.ShowDialog(this) != true) return;
        try { doc.SaveAs(d.FileName); }
        catch (Exception x) { MessageBox.Show(this, x.Message, "Salva progetto", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    // ------------------------------------------------------------------ tastiera
    void OnKey(object s, KeyEventArgs e)
    {
        if (Keyboard.FocusedElement is TextBox) return;
        var mod = Keyboard.Modifiers;
        if (e.Key == Key.Space && mod == ModifierKeys.None) { TogglePlay(); e.Handled = true; }
        else if (e.Key == Key.Z && mod == ModifierKeys.Control) { doc.Undo(); e.Handled = true; }
        else if ((e.Key == Key.Y && mod == ModifierKeys.Control) || (e.Key == Key.Z && mod == (ModifierKeys.Control | ModifierKeys.Shift))) { doc.Redo(); e.Handled = true; }
        else if (e.Key == Key.S && mod == ModifierKeys.Control) { SaveFile(); e.Handled = true; }
        else if (e.Key == Key.O && mod == ModifierKeys.Control) { OpenFile(); e.Handled = true; }
        else if (e.Key == Key.N && mod == (ModifierKeys.Control | ModifierKeys.Alt)) { NewTracks(); e.Handled = true; }
        else if (e.Key == Key.B && mod == ModifierKeys.None && !(Keyboard.FocusedElement is DeviceView)) { ToggleLibrary(); e.Handled = true; }
    }

    // ------------------------------------------------------------------ prova automatica (CI)
    void DemoContent()
    {
        doc.Load(JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Assets", "empty-project.json")))!.AsObject(), false);
        doc.SetTracks(new[] { 0, 1, 2, 8, 10 });
        var p = doc.Pat;
        var steps = (JsonArray)p["steps"]!;
        foreach (var (t, s, v) in new[] { (0, 0, 2), (0, 8, 1), (1, 4, 2), (1, 12, 1), (2, 2, 1), (2, 6, 1), (2, 10, 1), (2, 14, 1) }) ((JsonArray)steps[t]!)[s] = v;
        var bass = (JsonArray)Doc.TrackOf(p, 8)["steps"]!;
        foreach (var (s, n) in new[] { (0, 45), (3, 45), (6, 48), (8, 43), (11, 45), (14, 52) }) bass[s] = new JsonObject { ["n"] = n, ["g"] = 2, ["a"] = s == 0 ? 1 : 0, ["sl"] = 0, ["ch"] = null };
        var pad = (JsonArray)Doc.TrackOf(p, 10)["steps"]!;
        pad[0] = new JsonObject { ["n"] = 57, ["g"] = 8, ["a"] = 0, ["sl"] = 0, ["ch"] = new JsonArray(0, 3, 7) };
        pad[8] = new JsonObject { ["n"] = 53, ["g"] = 8, ["a"] = 0, ["sl"] = 0, ["ch"] = new JsonArray(0, 4, 7) };
        doc.Chain(8).Add(DeviceSpecs.New("filter")); doc.Chain(8).Add(DeviceSpecs.New("comp")); doc.Chain(8).Add(DeviceSpecs.New("reverb"));
        doc.PushAll();
        sel = 8;
    }

    void SelfTest()
    {
        try
        {
            // Giro delle funzioni principali, poi istantanea della finestra
            SetBottom("roll"); RenderBottom();
            SetBottom("dev");
            library.ShowEffects();
            UpdateLayout();
            var dpi = VisualTreeHelper.GetDpi(this);
            var rtb = new RenderTargetBitmap((int)(ActualWidth * dpi.DpiScaleX), (int)(ActualHeight * dpi.DpiScaleY), dpi.PixelsPerInchX, dpi.PixelsPerInchY, PixelFormats.Pbgra32);
            rtb.Render((Visual)Content);
            var enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(rtb));
            using (var f = File.Create(selftest!)) enc.Save(f);
            Console.WriteLine($"selftest ok: {selftest}");
            Application.Current.Shutdown(0);
        }
        catch (Exception x)
        {
            Console.Error.WriteLine(x.ToString());
            Application.Current.Shutdown(2);
        }
    }
}
