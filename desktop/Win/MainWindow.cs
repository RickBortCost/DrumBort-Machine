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
    readonly Timeline timeline;
    readonly ScrollViewer tlScroll = new() { HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled };
    readonly AutomationView autoView;
    readonly MixerView mixerView;
    int busSel = -1;
    EditorPanel? lastEditor; int editorSlot = -1, editorSteps = -1;              // ritorno, master o stack mostrato nel DEVICE (−1 = la traccia selezionata)
    ScrollViewer tracksSv = null!;
    EditorPanel? editor;
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
    readonly Btn libB = new("◧", 0, "Mostra/nascondi la Libreria (B)"), devTab = new("DEVICE"), rollTab = new("EDITOR", 0, "Note del pattern della traccia selezionata"), autoTab = new("AUTOMAZIONE"), mixTab = new("MIXER", 0, "Strisce di tracce, Track Stack, ritorni e master (X)");
    readonly Btn stepB = new("STEP", 0, "Pattern: step di tutte le tracce (F6)"), arrB = new("ARRANGIAMENTO", 0, "Timeline: i pattern disposti sulle battute (F5) · Tab alterna le viste");
    bool metOn;
    // MIDI
    readonly Btn rec = new("● REC", 0, "Registra le note MIDI negli step mentre suona (R)");
    readonly TextBlock midiStatus = Txt.Make("", 11, Theme.Cyan);
    bool recOn, recSnap;
    readonly Dictionary<int, (int ch, int step, long tick)> held = new();
    DispatcherTimer? statusTimer;

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
        devices = new DeviceView(doc) { OpenLibrary = OpenLibraryFor, ShowNotes = () => SetBottom("roll"), OpenWavetable = c => WavetableWindow.Open(this, doc, c) };
        library.AddDevice = t => { if (sel >= 0) { devices.Add(t, null); SetBottom("dev"); } };
        // Plugin VST 3: chiusura sul thread dell'interfaccia, stato nel progetto prima di salvare
        Vst3.Reaper = p => Dispatcher.BeginInvoke(() => { Vst3Editor.CloseFor(p); p.Dispose(); });
        Doc.CaptureStates = CaptureVst3;
        autoView = new AutomationView(doc);
        mixerView = new MixerView(doc);
        mixerView.Pick += id =>
        {
            if (Doc.IsBus(id)) { busSel = id; SetBottom("dev"); }
            else Select(id, true, false);
        };
        timeline = new Timeline(doc);
        tlScroll.Content = timeline;
        tlScroll.SizeChanged += (_, _) => { if (doc.ArrView) timeline.Reload(tlScroll.ActualWidth); };
        // Rotella: scorrimento verticale dell'elenco tracce (Shift = orizzontale, Ctrl = zoom della timeline)
        tlScroll.PreviewMouseWheel += (_, e) =>
        {
            var mod = Keyboard.Modifiers;
            if (mod.HasFlag(ModifierKeys.Control)) return;
            e.Handled = true;
            if (mod.HasFlag(ModifierKeys.Shift)) tlScroll.ScrollToHorizontalOffset(tlScroll.HorizontalOffset - e.Delta);
            else tracksSv.ScrollToVerticalOffset(tracksSv.VerticalOffset - e.Delta / 3.0);
        };
        timeline.RegionPicked += (ch, slot) =>
        {
            if (doc.Slot != slot) { doc.Slot = slot; doc.CommitQuiet("slot"); slotDd.Value = slot.ToString(); RefreshPatternBar(); }
            Select(ch, false, false);
        };
        timeline.OpenPattern += slot => { doc.Slot = slot; doc.CommitQuiet("slot"); SetView(false); };

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
        else
        {
            MidiInput.NoteOn += OnNoteOn;
            MidiInput.NoteOff += OnNoteOff;
            MidiLearn.Status += Flash;
            Loaded += (_, _) =>
            {
                MidiInput.Start(Dispatcher);
                if (MidiInput.Names.Count > 0) Flash("MIDI: " + string.Join(", ", MidiInput.Names));
                // Driver ASIO scelto l'ultima volta
                if (Program.RealAudio && Program.Engine != null && Settings.Load("asio") is string drv && drv != "")
                    try { Asio.Start(Program.Engine, drv); } catch (Exception x) { Flash($"ASIO {drv} non disponibile: {x.Message}"); }
            };
            Closed += (_, _) => { MidiInput.Stop(); if (Program.Engine != null && Asio.Driver is string d) { try { Asio.Stop(Program.Engine); } catch { } Settings.Save("asio", d); } };
        }
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
        var sv = tracksSv = new ScrollViewer { Content = tracksGrid, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Background = Theme.Bg };
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
        stepB.Click += () => SetView(false); arrB.Click += () => SetView(true);
        tb.Children.Add(stepB); tb.Children.Add(arrB);
        tb.Children.Add(new Border { Width = 16 });
        var add = new Btn("＋ TRACCIA", 0, "Nuove tracce (Ctrl+Alt+N)") { Fg = Theme.Green };
        add.Click += NewTracks;
        tb.Children.Add(add);
        var drummer = new Btn("🥁 DRUMMER", 0, "Drummer e Session Player: batteria, basso e accordi generati da stile e pad XY (D)");
        drummer.Click += OpenPlayers;
        tb.Children.Add(drummer);
        var wtB = new Btn("〰 WAVETABLE", 0, "Synth wavetable in una finestra a parte: si applica come strumento a una traccia synth, anche vuota (W)");
        wtB.Click += OpenWavetable;
        tb.Children.Add(wtB);
        libB.Click += ToggleLibrary;
        tb.Children.Add(libB);
        tb.Children.Add(new Border { Width = 16 });
        devTab.Click += () => SetBottom("dev"); rollTab.Click += () => SetBottom("roll"); autoTab.Click += () => SetBottom("auto"); mixTab.Click += () => SetBottom("mix");
        tb.Children.Add(Txt.Make("IN BASSO", 10, Theme.Dim));
        tb.Children.Add(devTab); tb.Children.Add(rollTab); tb.Children.Add(autoTab); tb.Children.Add(mixTab);
        tb.Children.Add(new Border { Width = 16 });
        var web = new Btn("INTERFACCIA COMPLETA", 0, "Session, macro, editor wavetable: interfaccia completa in una finestra a parte");
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
        swing.LearnId = "swing";
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
        rec.OnBrush = new SolidColorBrush(Color.FromRgb(0x5a, 0x1e, 0x1a)); rec.OnBorder = Theme.Red; rec.Fg = Theme.Red;
        rec.Click += ToggleRec;
        sp.Children.Add(rec);

        undoB.Click += doc.Undo; redoB.Click += doc.Redo;
        sp.Children.Add(new Border { Width = 10 });
        sp.Children.Add(undoB); sp.Children.Add(redoB);
        var file = new Btn("FILE ▾", 0, "Nuovo, apri, salva");
        file.Click += () => Menu.Show(file, new (string, Action?)[]
        {
            ("Nuovo progetto", () => { if (MessageBox.Show(this, "Nuovo progetto vuoto? Quello attuale resta annullabile con Ctrl+Z.", "DrumBort", MessageBoxButton.OKCancel) == MessageBoxResult.OK) { doc.New(); sel = -1; } }),
            ("Apri…  (Ctrl+O)", OpenFile),
            ("Salva con nome…  (Ctrl+S)", SaveFile),
            ("Esporta audio (WAV, stem)…  (Ctrl+E)", ExportAudio),
        });
        sp.Children.Add(file);
        var audio = new Btn("🎧 AUDIO/MIDI", 0, "Uscita audio, driver ASIO, latenza, tastiere e controller MIDI");
        audio.Click += () => new AudioDialog(this).ShowDialog();
        var phone = new Btn("📱 TELEFONO", 0, "Collega il telefono (QR code)");
        phone.Click += () => new PhoneDialog(this).ShowDialog();
        sp.Children.Add(audio); sp.Children.Add(phone);
        var mm = new StackPanel { Margin = new Thickness(10, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        mm.Children.Add(Txt.Make("MASTER", 9, Theme.Dim)); mm.Children.Add(masterMeter);
        sp.Children.Add(mm);
        midiStatus.Margin = new Thickness(12, 0, 0, 0); midiStatus.VerticalAlignment = VerticalAlignment.Center;
        sp.Children.Add(midiStatus);
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
        RefreshPatternBar();
        undoB.Enabled = doc.CanUndo; redoB.Enabled = doc.CanRedo;
        libB.IsOn = libOpen;
        stepB.IsOn = !doc.ArrView; arrB.IsOn = doc.ArrView;
        BuildTracks();
        library.Render();
        RenderBottom();
    }

    /// <summary>BPM, swing, pattern, battute e kit del pattern selezionato.</summary>
    void RefreshPatternBar()
    {
        bpm.Text = Bpm.ToString(CultureInfo.InvariantCulture);
        int sw = (int)Doc.Num(doc.Pat, "swing", 50);
        swing.Set(sw); swingTxt.Text = $"{sw} %";
        slotDd.Value = doc.Slot.ToString();
        barsDd.Value = doc.Bars.ToString();
        kitDd.SetItems(Kits.All.Select(k => (k.Id, k.Name)));
        kitDd.Value = Doc.Str(doc.Pat, "kit", Kits.All[0].Id);
    }

    /// <summary>Vista STEP (pattern) o ARRANGIAMENTO (timeline). Il motore suona quello che si vede.</summary>
    void SetView(bool arr)
    {
        if (doc.ArrView == arr) { Refresh(); return; }
        bool playing = Program.Engine?.Seq.Playing ?? false;
        if (playing) doc.Op("stop");
        doc.ArrView = arr;
        doc.SyncArrMode();
        Refresh();
        if (playing) TogglePlay();
    }

    void BuildTracks()
    {
        heads.Children.Clear(); stepRows.Clear(); meters.Clear(); headerOf.Clear();
        var tracks = doc.Tracks;
        if (doc.ArrView)
        {
            // La timeline resta la stessa (un trascinamento in corso non si interrompe)
            if (!(rows.Children.Count == 1 && rows.Children[0] == tlScroll)) { rows.Children.Clear(); rows.Children.Add(tlScroll); }
            heads.Children.Add(new Border { Height = Timeline.RulerH, Background = Theme.Panel, Child = Txt.Make("  Clic: dipingi il pattern selezionato · Ctrl+trascina: copia · tasto destro: menu", 10, Theme.Dim) });
            foreach (int ch in tracks) heads.Children.Add(TrackHeader(ch));
            timeline.Reload(tlScroll.ActualWidth);
            return;
        }
        rows.Children.Clear();
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
        vol.LearnId = $"trk:{ch}:vol"; pan.LearnId = $"trk:{ch}:pan";
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
            // Clic sulla traccia: in basso le sue note (piano roll o step), solo di questa traccia
            bottom = "roll";
            Select(ch, false, true);
        };
        b.AllowDrop = true;
        b.DragOver += (_, e) => { e.Effects = DeviceView.IsNewDevice(e.Data, out string _t) ? DragDropEffects.Copy : DragDropEffects.None; e.Handled = true; };
        b.Drop += (_, e) => { if (DeviceView.IsNewDevice(e.Data, out var type)) { Select(ch, true, false); devices.Add(type, null); } };
        return b;
    }

    /// <summary>Seleziona la traccia: intestazione evidenziata, Libreria e pannello in basso aggiornati.</summary>
    void Select(int ch, bool showDevices, bool preview)
    {
        sel = ch; busSel = -1;
        if (showDevices) bottom = "dev";
        else if (bottom is "dev" or "roll") bottom = "roll";
        if (preview) { if (Doc.IsSynth(ch)) doc.PreviewSynth(ch - 8, doc.Base(ch - 8)); else doc.PreviewDrum(ch); }
        foreach (var (c, h) in headerOf) h.Background = c == sel ? Theme.Panel3 : Theme.Panel2;
        library.Render();
        RenderBottom();
    }

    void SetBottom(string m) { bottom = m; RenderBottom(); }

    void RenderBottom()
    {
        devTab.IsOn = bottom == "dev"; rollTab.IsOn = bottom == "roll"; autoTab.IsOn = bottom == "auto"; mixTab.IsOn = bottom == "mix";
        editor = null;
        if (busSel >= 0 && !doc.BusExists(busSel)) busSel = -1;
        if (bottom == "mix")
        {
            roll = null;
            mixerView.Selected = busSel >= 0 ? busSel : sel;
            mixerView.Render();
            bottomHost.Content = mixerView;
            return;
        }
        if (bottom == "auto")
        {
            roll = null;
            autoView.Ch = sel;
            autoView.Render();
            bottomHost.Content = autoView;
            return;
        }
        if (bottom == "roll")
        {
            // Stesso editor se la traccia e il pattern non cambiano (scorrimento e parametro restano)
            if (lastEditor is EditorPanel ep && ep.Ch == sel && editorSlot == doc.Slot && editorSteps == doc.StepCount && sel >= 0)
            {
                editor = ep; roll = ep.Roll; ep.Redraw();
                if (bottomHost.Content != ep) bottomHost.Content = ep;
                return;
            }
            if (sel < 0)
            {
                roll = null;
                var t = Txt.Make("Seleziona una traccia.", 13, Theme.Dim); t.Margin = new Thickness(16);
                bottomHost.Content = new Border { Background = Theme.Panel, Child = t };
                return;
            }
            editor = lastEditor = new EditorPanel(doc, sel);
            editorSlot = doc.Slot; editorSteps = doc.StepCount;
            roll = editor.Roll;
            bottomHost.Content = editor;
            return;
        }
        roll = null;
        devices.Ch = bottom == "dev" && busSel >= 0 ? busSel : sel;
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
        if (d.Wavetable && sel >= 8) WavetableWindow.Open(this, doc, sel, applyNow: true);
        else if (d.OpenLibrary) OpenLibraryFor(sel);
    }

    /// <summary>Editor wavetable sulla traccia synth selezionata, altrimenti sulla prima traccia synth vuota.</summary>
    void OpenWavetable()
    {
        int target = sel >= 8 ? sel : Enumerable.Range(8, 4).FirstOrDefault(c => !doc.Tracks.Contains(c), 8);
        WavetableWindow.Open(this, doc, target);
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
        if (playing) doc.Op("stop");
        else doc.Op("play", doc.ArrView ? new JsonObject { ["from"] = timeline.Start } : null);
    }

    /// <summary>Stato dei plugin aperti → p.state di ogni device vst3 (tracce, ritorni, master, stack).</summary>
    void CaptureVst3(JsonObject root)
    {
        var chains = new List<JsonArray>();
        if (root["devs"] is JsonArray devs) chains.AddRange(devs.OfType<JsonArray>());
        if (root["buses"] is JsonObject b)
        {
            if (b["ret"] is JsonArray r) chains.AddRange(r.Select(x => x?["devs"]).OfType<JsonArray>());
            if (b["master"]?["devs"] is JsonArray m) chains.Add(m);
            if (b["stacks"] is JsonArray st) chains.AddRange(st.Select(x => x?["devs"]).OfType<JsonArray>());
        }
        foreach (var d in chains.SelectMany(c => c.OfType<JsonObject>()).Where(d => Doc.Str(d, "type", "") == "vst3"))
        {
            Vst3.Plugin? p;
            lock (Vst3.Live) Vst3.Live.TryGetValue(Doc.Str(d, "id", ""), out p);
            if (p == null) continue;
            try
            {
                string st = p.GetState();
                if (st != "" && d["p"] is JsonObject pp) { pp["state"] = st; p.AppliedState = st; }
            }
            catch (Exception e) { Console.Error.WriteLine($"[vst3] stato: {e.Message}"); }
        }
    }

    void OpenPlayers() => new PlayersDialog(this, doc, sel).ShowDialog();
    void ExportAudio() => new ExportDialog(this, doc).ShowDialog();
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
        editor?.SetPlayhead(step);
        if (bottom == "auto" && bottomHost.Content == autoView) autoView.SetPlayhead(step);
        if (bottom == "mix" && bottomHost.Content == mixerView) mixerView.UpdateMeters(e);
        if (doc.ArrView)
        {
            bool arrOn = playing && timeline.Length > 0;
            double ph = arrOn ? e.Seq.ArrBar + (e.Seq.Tick % 16) / 16.0 : -1;
            if (Math.Abs(ph - timeline.Playhead) > 1e-6) { timeline.Playhead = ph; timeline.InvalidateVisual(); }
            if (arrOn) { long t = e.Seq.Tick % 16; pos.Text = $"{e.Seq.ArrBar + 1}.{t / 4 + 1}.{t % 4 + 1}"; }
            else if (playing) pos.Text = $"{step / 16 + 1}.{step % 16 / 4 + 1}.{step % 4 + 1}";
        }
        else if (playing) pos.Text = $"{step / 16 + 1}.{step % 16 / 4 + 1}.{step % 4 + 1}";
        var pk = e.Mx.Peaks;
        foreach (var (ch, m) in meters) m.Set(pk[ch]);
        masterMeter.Set(pk[Mixer.Channels]);
    }

    // ------------------------------------------------------------------ MIDI
    void Flash(string msg)
    {
        midiStatus.Text = msg;
        statusTimer ??= new DispatcherTimer { Interval = TimeSpan.FromSeconds(4) };
        statusTimer.Tick -= ClearFlash; statusTimer.Tick += ClearFlash;
        statusTimer.Stop(); if (msg != "") statusTimer.Start();
    }
    void ClearFlash(object? s, EventArgs e) { statusTimer!.Stop(); midiStatus.Text = ""; }

    void ToggleRec()
    {
        recOn = !recOn; rec.IsOn = recOn; recSnap = false;
        Flash(recOn ? "REC: le note MIDI suonate durante la riproduzione vanno negli step" : "");
    }

    /// <summary>Destinazione della nota: pad di batteria (36–43 o canale 10) o traccia synth selezionata.</summary>
    int Target(int midiCh, int note)
    {
        bool pad = note >= 36 && note <= 43;
        if (pad && (midiCh == 10 || sel < 8)) return note - 36;
        if (sel >= 8) return sel;
        return -1;
    }

    /// <summary>Step in riproduzione (lo scheduler è avanti di pochi millisecondi).</summary>
    int RecStep(out long tick)
    {
        tick = -1;
        var e = Program.Engine;
        if (!recOn || e == null || !e.Seq.Playing) return -1;
        tick = Math.Max(0, e.Seq.Tick - 1);
        return (int)(tick % doc.StepCount);
    }

    void OnNoteOn(int midiCh, int note, int vel)
    {
        int ch = Target(midiCh, note);
        if (ch < 0) return;
        double v = vel / 127.0;
        if (ch < 8) doc.Op("trig", new JsonObject { ["i"] = ch, ["vel"] = Math.Max(0.2, v) });
        else doc.Op("non", new JsonObject { ["k"] = ch - 8, ["notes"] = new JsonArray(note), ["vel"] = Math.Max(0.2, v), ["cid"] = "midi", ["id"] = note.ToString() });
        int s = RecStep(out long tick);
        if (s < 0) { if (ch >= 8) held[note] = (ch, -1, -1); return; }
        if (!recSnap) { doc.Snapshot(); recSnap = true; }
        if (!doc.Tracks.Contains(ch)) { doc.SetTracks(doc.Tracks.Append(ch)); doc.SetAll(ch, "mute", false); doc.Commit(new[] { "tracks" }.Concat(doc.AllPatKeys).ToArray()); }
        if (ch < 8)
        {
            ((JsonArray)doc.Pat["steps"]![ch]!)[s] = vel >= 100 ? 2 : 1;
        }
        else
        {
            var steps = (JsonArray)Doc.TrackOf(doc.Pat, ch)["steps"]!;
            // Note insieme sullo stesso step: accordo (intervalli dalla nota più bassa)
            if (steps[s] is JsonObject st && held.Values.Any(h => h.ch == ch && h.step == s))
            {
                int root = (int)Doc.Num(st, "n", note);
                var chord = (st["ch"] as JsonArray)?.Select(x => (int)Doc.Val(x)).ToList() ?? new List<int> { 0 };
                chord.Add(note - root);
                int lo = chord.Min();
                st["n"] = root + lo;
                st["ch"] = new JsonArray(chord.Select(x => x - lo).Distinct().OrderBy(x => x).Select(x => (JsonNode)x).ToArray());
            }
            else steps[s] = new JsonObject { ["n"] = note, ["g"] = 1, ["a"] = vel >= 100 ? 1 : 0, ["sl"] = 0, ["ch"] = null };
            held[note] = (ch, s, tick);
        }
        doc.CommitQuiet(doc.PatKey);
        RedrawNotes();
    }

    void OnNoteOff(int midiCh, int note)
    {
        if (!held.Remove(note, out var h)) return;
        doc.Op("noff", new JsonObject { ["cid"] = "midi", ["id"] = note.ToString() });
        if (h.step < 0 || Program.Engine is not AudioEngine e) return;
        // Durata registrata in step (almeno 1)
        long len = Math.Max(1, e.Seq.Tick - 1 - h.tick);
        if (Doc.TrackOf(doc.Pat, h.ch)["steps"] is JsonArray steps && steps[h.step] is JsonObject st)
        {
            st["g"] = (int)Math.Min(len, doc.StepCount);
            doc.CommitQuiet(doc.PatKey);
            RedrawNotes();
        }
    }

    void RedrawNotes()
    {
        foreach (var r in stepRows) r.InvalidateVisual();
        editor?.Redraw();
        if (doc.ArrView) timeline.InvalidateVisual();
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
        else if (e.Key == Key.E && mod == ModifierKeys.Control) { ExportAudio(); e.Handled = true; }
        else if (e.Key == Key.R && mod == ModifierKeys.None) { ToggleRec(); e.Handled = true; }
        else if (e.Key == Key.D && mod == ModifierKeys.None && !(Keyboard.FocusedElement is Timeline)) { OpenPlayers(); e.Handled = true; }
        else if (e.Key == Key.W && mod == ModifierKeys.None) { OpenWavetable(); e.Handled = true; }
        else if (e.Key == Key.X && mod == ModifierKeys.None) { SetBottom(bottom == "mix" ? "dev" : "mix"); e.Handled = true; }
        else if (e.Key == Key.F5 && mod == ModifierKeys.None) { SetView(true); e.Handled = true; }
        else if (e.Key == Key.F6 && mod == ModifierKeys.None) { SetView(false); e.Handled = true; }
        else if (e.Key == Key.Tab && mod == ModifierKeys.None) { SetView(!doc.ArrView); e.Handled = true; }
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
        // Pattern 2 (variazione), arrangiamento di 8 battute e automazione del cutoff del basso
        doc.Root["slots"]![1] = p.DeepClone();
        var p2 = doc.PatAt(1);
        foreach (int s in new[] { 2, 6, 10, 14 }) ((JsonArray)p2["steps"]![1]!)[s] = 1;
        p["auto"] = new JsonObject { ["s0.cut"] = new JsonArray(Enumerable.Range(0, 16).Select(i => (JsonNode)Math.Round(0.2 + 0.6 * i / 15.0, 3)).ToArray()) };
        var bars = new List<(int[] m, int s)>();
        for (int b = 0; b < 8; b++)
        {
            var m = Enumerable.Repeat(-1, 12).ToArray();
            int slot = b >= 4 && b < 6 ? 1 : 0;
            m[0] = slot; m[8] = b >= 2 ? slot : -1; m[10] = b >= 4 ? slot : -1; m[1] = b >= 1 ? slot : -1; m[2] = b % 4 == 3 ? -1 : slot;
            bars.Add((m, slot));
        }
        doc.ArrBars = bars;
        doc.PushAll();
        sel = 8;
    }

    void Shot(string path)
    {
        UpdateLayout();
        var dpi = VisualTreeHelper.GetDpi(this);
        var rtb = new RenderTargetBitmap((int)(ActualWidth * dpi.DpiScaleX), (int)(ActualHeight * dpi.DpiScaleY), dpi.PixelsPerInchX, dpi.PixelsPerInchY, PixelFormats.Pbgra32);
        rtb.Render((Visual)Content);
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(rtb));
        using var f = File.Create(path);
        enc.Save(f);
    }

    static void ShotOf(Window w, string path)
    {
        var dpi = VisualTreeHelper.GetDpi(w);
        var rtb = new RenderTargetBitmap((int)(w.ActualWidth * dpi.DpiScaleX), (int)(w.ActualHeight * dpi.DpiScaleY), dpi.PixelsPerInchX, dpi.PixelsPerInchY, PixelFormats.Pbgra32);
        var host = new System.Windows.Shapes.Rectangle();
        rtb.Render((Visual)w.Content);
        var enc = new PngBitmapEncoder(); enc.Frames.Add(BitmapFrame.Create(rtb));
        using var f = File.Create(path);
        enc.Save(f);
    }

    void SelfTest()
    {
        try
        {
            // Giro delle funzioni principali, poi istantanee della finestra
            SetBottom("roll"); RenderBottom();
            SetBottom("dev");
            library.ShowEffects();
            Shot(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(selftest!))!, Path.GetFileNameWithoutExtension(selftest) + "-step.png"));
            // Editor della traccia synth: piano roll con scala (solo la traccia), graph editor
            Select(8, false, false); SetBottom("roll");
            Shot(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(selftest!))!, Path.GetFileNameWithoutExtension(selftest) + "-editor.png"));
            // Track Stack con batteria, effetto sul ritorno A, mixer
            doc.SetStack(0, 0); doc.SetStack(1, 0); doc.SetStack(2, 0);
            doc.Chain(Doc.StackBase).Add(DeviceSpecs.New("comp"));
            doc.Chain(Doc.RetA).Add(DeviceSpecs.New("eq"));
            ((JsonObject)doc.Root["fx"]!)["sc"] = 0.5;
            doc.Commit("buses", "fx");
            SetBottom("mix");
            Shot(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(selftest!))!, Path.GetFileNameWithoutExtension(selftest) + "-mixer.png"));
            busSel = Doc.MasterBus; SetBottom("dev");
            Shot(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(selftest!))!, Path.GetFileNameWithoutExtension(selftest) + "-master.png"));
            SetView(true);
            Select(8, false, false);
            SetBottom("auto");
            Dispatcher.Invoke(() => { }, DispatcherPriority.Background);
            Shot(selftest!);
            // Export offline (lo stesso del menu FILE): 1 ripetizione del pattern e l'arrangiamento
            var parts = doc.Parts(null);
            foreach (var src in new[] { "pattern", "arr" })
            {
                var (l, r) = Exporter.Render(parts, new Exporter.Options(src, 1), null, null, CancellationToken.None);
                string wav = Path.Combine(Path.GetTempPath(), $"drumbort-selftest-{src}.wav");
                Exporter.WriteWav(wav, l, r, 48000, 24);
                double pk = l.Max(Math.Abs);
                Console.WriteLine($"export {src}: {l.Length / 48000.0:0.00} s, peak {pk:0.000}");
                if (pk < 0.01) throw new Exception($"export {src} silenzioso");
            }
            // Drummer e Session Player su una copia del pattern
            var test = (JsonObject)doc.Pat.DeepClone();
            foreach (var st in Players.DrumStyles)
            {
                Players.Drums(test, st.id, 0.7, 0.7, Enumerable.Repeat(true, 8).ToArray(), 0.5, 3);
                int hits = ((JsonArray)test["steps"]!).Sum(r => ((JsonArray)r!).Count(v => Doc.Val(v) > 0));
                Console.WriteLine($"drummer {st.id}: {hits} colpi");
                if (hits < 6) throw new Exception($"drummer {st.id}: troppo pochi colpi");
            }
            var pdlg = new PlayersDialog(this, doc, 0);
            pdlg.Show(); pdlg.UpdateLayout();
            ShotOf(pdlg, Path.Combine(Path.GetDirectoryName(Path.GetFullPath(selftest!))!, Path.GetFileNameWithoutExtension(selftest) + "-drummer.png"));
            pdlg.Close();
            // Plugin VST 3 (sul CI: ADelay compilato dall'SDK, cartella in DRUMBORT_VST3_PATH)
            Console.WriteLine($"vst3: libreria {(Vst3.Available ? "presente" : "assente")}");
            if (Environment.GetEnvironmentVariable("DRUMBORT_VST3_PATH") is string vdir && vdir != "")
            {
                int code = Tools.Vst3Test(vdir);
                if (code != 0) throw new Exception($"vst3: prova non riuscita ({code})");
                var found = Vst3.Scan().FirstOrDefault(p => p.Name == "ADelay") ?? throw new Exception("vst3: ADelay non trovato");
                busSel = -1; Select(0, true, false);
                devices.Add(DeviceView.Vst3Type(found), null);
                Dispatcher.Invoke(() => { }, DispatcherPriority.Background);
                System.Threading.Thread.Sleep(300);
                Dispatcher.Invoke(() => { }, DispatcherPriority.Background);
                devices.Render();
                Shot(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(selftest!))!, Path.GetFileNameWithoutExtension(selftest) + "-vst3.png"));
                var exp = doc.Export();
                var (vl, _) = Exporter.Render(doc.Parts(null), new Exporter.Options("pattern", 1), 0, null, CancellationToken.None);
                Console.WriteLine($"vst3: export con ADelay, picco {vl.Max(Math.Abs):0.000}, stato salvato {(exp.ToJsonString().Contains("\"state\"") ? "sì" : "no")}");
            }
            // Editor wavetable (finestra non modale) applicato alla traccia KEYS, che era vuota
            WavetableWindow.Open(this, doc, 11, applyNow: true);
            var wtw = WavetableWindow.Current!;
            wtw.UpdateLayout();
            ShotOf(wtw, Path.Combine(Path.GetDirectoryName(Path.GetFullPath(selftest!))!, Path.GetFileNameWithoutExtension(selftest) + "-wavetable.png"));
            if (!doc.Tracks.Contains(11) || Doc.TrackOf(doc.Pat, 11)["patch"]?["wt"] == null) throw new Exception("wavetable: patch non applicata alla traccia vuota");
            Console.WriteLine("wavetable: patch applicata a KY");
            wtw.Close();
            // Audio e MIDI: driver ASIO e ingressi MIDI (sul runner nessuno), finestra di dialogo
            Console.WriteLine($"asio: {Asio.Drivers().Length} driver");
            MidiInput.Start(Dispatcher);
            Console.WriteLine($"midi: {MidiInput.Names.Count} ingressi");
            var ad = new AudioDialog(this);
            ad.Show();
            ad.UpdateLayout();
            var dpi = VisualTreeHelper.GetDpi(ad);
            var rtb = new RenderTargetBitmap((int)(ad.ActualWidth * dpi.DpiScaleX), (int)(ad.ActualHeight * dpi.DpiScaleY), dpi.PixelsPerInchX, dpi.PixelsPerInchY, PixelFormats.Pbgra32);
            rtb.Render((Visual)ad.Content);
            var enc = new PngBitmapEncoder(); enc.Frames.Add(BitmapFrame.Create(rtb));
            using (var f = File.Create(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(selftest!))!, Path.GetFileNameWithoutExtension(selftest) + "-audio.png"))) enc.Save(f);
            ad.Close();
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
