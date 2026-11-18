// Dialogs.cs — Finestre di dialogo: Nuove tracce (come Logic Pro), uscita audio, collega telefono.

using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using DrumBort.Host;

namespace DrumBort.Win;

/// <summary>Finestra di dialogo con il tema scuro.</summary>
public class DarkDialog : Window
{
    protected readonly StackPanel Body = new() { Margin = new Thickness(18) };
    public DarkDialog(Window owner, string title, double width)
    {
        Owner = owner; Title = title; Width = width; SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner; ResizeMode = ResizeMode.NoResize;
        Background = Theme.Panel2; Foreground = Theme.Ink; ShowInTaskbar = false;
        var t = Txt.Make(title.ToUpperInvariant(), 15, Theme.Ink, true);
        t.Margin = new Thickness(0, 0, 0, 12);
        Body.Children.Add(t);
        Content = Body;
        KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Escape) Close(); };
    }
    protected StackPanel Buttons(params Btn[] b)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 14, 0, 0) };
        foreach (var x in b) { x.MinWidth = 96; sp.Children.Add(x); }
        Body.Children.Add(sp);
        return sp;
    }
}

/// <summary>
/// Nuove tracce: tipo (strumento software, voce di batteria, kit completo), strumento o voce,
/// numero di tracce, Apri Libreria. Il progetto ha 4 canali synth e 8 di batteria.
/// </summary>
public sealed class NewTrackDialog : DarkDialog
{
    public List<int> Result = new();
    public bool OpenLibrary = true;
    readonly Doc doc;
    string type;
    readonly StackPanel cards = new() { Orientation = Orientation.Horizontal };
    readonly StackPanel details = new() { MinHeight = 70 };
    readonly Btn create = new("Crea") { IsOn = true };
    ComboBox? which; TextBox? count;

    public NewTrackDialog(Window owner, Doc doc) : base(owner, "Nuove tracce", 640)
    {
        this.doc = doc;
        type = FreeSynth().Count > 0 ? "inst" : "drum";
        Body.Children.Add(cards);
        details.Margin = new Thickness(0, 14, 0, 0);
        Body.Children.Add(details);
        var lib = new CheckBox { Content = "Apri Libreria", IsChecked = true, Foreground = Theme.Ink, Margin = new Thickness(0, 10, 0, 0) };
        lib.Checked += (_, _) => OpenLibrary = true; lib.Unchecked += (_, _) => OpenLibrary = false;
        Body.Children.Add(lib);
        var cancel = new Btn("Annulla");
        cancel.Click += Close;
        create.Click += Create;
        Buttons(cancel, create);
        Render();
        KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Enter) Create(); };
    }
    List<int> FreeSynth() => Enumerable.Range(8, 4).Where(i => !doc.Tracks.Contains(i)).ToList();
    List<int> FreeDrum() => Enumerable.Range(0, 8).Where(i => !doc.Tracks.Contains(i)).ToList();

    void Render()
    {
        cards.Children.Clear();
        foreach (var (id, icon, name, desc) in new[]
        {
            ("inst", "🎹", "Strumento software", "Synth con i suoni della Libreria"),
            ("drum", "🥁", "Batteria", "Una o più voci del kit"),
            ("kit", "◫", "Kit di batteria", "Tutte le voci libere del kit"),
        })
        {
            var sp = new StackPanel { Margin = new Thickness(10) };
            var ic = Txt.Make(icon, 28); ic.HorizontalAlignment = HorizontalAlignment.Center;
            var nm = Txt.Make(name, 13, Theme.Ink, true); nm.HorizontalAlignment = HorizontalAlignment.Center;
            var ds = Txt.Make(desc, 11, Theme.Dim); ds.HorizontalAlignment = HorizontalAlignment.Center; ds.TextWrapping = TextWrapping.Wrap; ds.TextAlignment = TextAlignment.Center;
            sp.Children.Add(ic); sp.Children.Add(nm); sp.Children.Add(ds);
            var b = new Border
            {
                Child = sp, Width = 190, Margin = new Thickness(0, 0, 8, 0), CornerRadius = new CornerRadius(6), Cursor = System.Windows.Input.Cursors.Hand,
                Background = id == type ? Theme.Panel3 : Theme.Panel, BorderBrush = id == type ? Theme.Orange : Theme.Edge, BorderThickness = new Thickness(id == type ? 2 : 1),
            };
            string tid = id;
            b.MouseLeftButtonUp += (_, _) => { type = tid; Render(); };
            cards.Children.Add(b);
        }
        details.Children.Clear();
        which = null; count = null;
        var free = type == "inst" ? FreeSynth() : FreeDrum();
        if (free.Count == 0)
        {
            details.Children.Add(Txt.Make(type == "inst" ? "Tutte e 4 le tracce synth sono già nel progetto." : "Tutte le voci del kit sono già nel progetto.", 13, Theme.Dim));
            create.Enabled = false;
            return;
        }
        create.Enabled = true;
        if (type == "kit")
        {
            details.Children.Add(Txt.Make($"Kit {doc.Kit.Name}: " + string.Join(" · ", free.Select(i => doc.Kit.Tracks[i].Short)), 13, Theme.Dim));
            return;
        }
        which = new ComboBox { Width = 300, Margin = new Thickness(0, 0, 0, 8) };
        foreach (int i in free) which.Items.Add(new ComboBoxItem { Content = type == "inst" ? $"{Doc.SynthNames[i - 8]} ({Doc.SynthShort[i - 8]})" : $"{doc.Kit.Tracks[i].Name} ({doc.Kit.Tracks[i].Short})", Tag = i });
        which.SelectedIndex = 0;
        count = new TextBox { Text = "1", Width = 60, Padding = new Thickness(4), Background = Theme.Dark, Foreground = Theme.Ink, BorderBrush = Theme.Edge, CaretBrush = Theme.Ink };
        details.Children.Add(Row(type == "inst" ? "Strumento" : "Voce", which));
        details.Children.Add(Row($"Numero di tracce (max {free.Count})", count));
    }
    static UIElement Row(string label, UIElement c)
    {
        var g = new DockPanel { Margin = new Thickness(0, 2, 0, 2) };
        var l = Txt.Make(label, 13); l.Width = 200;
        DockPanel.SetDock(l, Dock.Left);
        g.Children.Add(l); g.Children.Add(c);
        return g;
    }
    void Create()
    {
        if (!create.Enabled) return;
        if (type == "kit") Result = FreeDrum();
        else
        {
            var free = type == "inst" ? FreeSynth() : FreeDrum();
            int first = which?.SelectedItem is ComboBoxItem ci ? (int)ci.Tag : free[0];
            int n = int.TryParse(count?.Text, out var v) ? Math.Clamp(v, 1, free.Count) : 1;
            Result = new[] { first }.Concat(free.Where(i => i != first)).Take(n).ToList();
        }
        DialogResult = true;
    }
}

/// <summary>Scelta dell'uscita audio (cuffie, casse, scheda).</summary>
public sealed class AudioDialog : DarkDialog
{
    public AudioDialog(Window owner) : base(owner, "Uscita audio", 460)
    {
        var e = Program.Engine;
        if (e == null || !Program.RealAudio)
        {
            Body.Children.Add(Txt.Make("Scheda audio non disponibile.", 13, Theme.Dim));
            var c = new Btn("Chiudi"); c.Click += Close; Buttons(c);
            return;
        }
        var info = Txt.Make($"In uso: {e.CurrentDevice}", 12, Theme.Dim);
        info.TextWrapping = TextWrapping.Wrap;
        Body.Children.Add(info);
        var list = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        void Fill()
        {
            list.Children.Clear();
            var def = new Btn("Predefinito di sistema (segue le cuffie collegate)") { IsOn = e.FollowDefault, HorizontalAlignment = HorizontalAlignment.Stretch };
            def.Click += () => { Try(() => e.SelectDevice(null)); Fill(); };
            list.Children.Add(def);
            foreach (var d in e.Devices())
            {
                var b = new Btn(d.name + (d.isDefault ? "  (predefinito)" : "")) { IsOn = !e.FollowDefault && d.name == e.CurrentDevice, HorizontalAlignment = HorizontalAlignment.Stretch };
                string n = d.name;
                b.Click += () => { Try(() => e.SelectDevice(n)); Fill(); };
                list.Children.Add(b);
            }
            info.Text = $"In uso: {e.CurrentDevice}";
        }
        Fill();
        Body.Children.Add(list);
        var refresh = new Btn("Rileggi dispositivi"); refresh.Click += () => { Try(e.Refresh); Fill(); };
        var close = new Btn("Chiudi"); close.Click += Close;
        Buttons(refresh, close);
    }
    void Try(Action a) { try { a(); } catch (Exception x) { MessageBox.Show(this, x.Message, "Uscita audio"); } }
}

/// <summary>QR code e indirizzo per collegare il telefono.</summary>
public sealed class PhoneDialog : DarkDialog
{
    public PhoneDialog(Window owner) : base(owner, "Collega telefono", 420)
    {
        var hint = Txt.Make("Inquadra il QR con la fotocamera del telefono (stessa rete Wi-Fi). Il Sound Lab del telefono manda i suoni creati nella Libreria del PC; con ?full alla fine dell'indirizzo il telefono comanda la drum machine.", 12, Theme.Dim);
        hint.TextWrapping = TextWrapping.Wrap; hint.TextTrimming = TextTrimming.None;
        Body.Children.Add(hint);
        var png = Program.Web != null ? Server.PhoneQrPng(Program.Port) : null;
        if (png == null)
        {
            Body.Children.Add(Txt.Make(Program.Web == null ? "Server per i telefoni non avviato." : "Nessuna rete locale: collega il PC al Wi-Fi.", 13, Theme.Red));
        }
        else
        {
            var bmp = new BitmapImage();
            bmp.BeginInit(); bmp.StreamSource = new MemoryStream(png); bmp.CacheOption = BitmapCacheOption.OnLoad; bmp.EndInit(); bmp.Freeze();
            var img = new Image { Source = bmp, Width = 240, Height = 240, Margin = new Thickness(0, 12, 0, 8) };
            RenderOptions.SetBitmapScalingMode(img, BitmapScalingMode.NearestNeighbor);
            Body.Children.Add(new Border { Background = Brushes.White, Padding = new Thickness(8), HorizontalAlignment = HorizontalAlignment.Center, Child = img, CornerRadius = new CornerRadius(6) });
            var url = new TextBox { Text = Server.PhoneUrl(Program.Port), IsReadOnly = true, Background = Theme.Dark, Foreground = Theme.Lcd, BorderThickness = new Thickness(0), FontSize = 15, HorizontalContentAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 0) };
            Body.Children.Add(url);
        }
        var close = new Btn("Chiudi"); close.Click += Close;
        Buttons(close);
    }
}

/// <summary>
/// Esporta audio (come "Bounce" di Logic / "Export" di FL Studio): sorgente (pattern, arrangiamento,
/// song), formato, frequenza, normalizzazione, stem (un file per traccia). Rendering in background.
/// </summary>
public sealed class ExportDialog : DarkDialog
{
    readonly Doc doc;
    string source;
    int reps = 4, rate = 48000, bits = 24;
    bool stems, normalize;
    readonly StackPanel opts = new();
    readonly ProgressBar bar = new() { Height = 8, Minimum = 0, Maximum = 1, Margin = new Thickness(0, 12, 0, 0), Visibility = Visibility.Collapsed };
    readonly TextBlock status = Txt.Make("", 12, Theme.Dim);
    readonly Btn go = new("Esporta…") { IsOn = true }, cancel = new("Chiudi");
    CancellationTokenSource? cts;

    public ExportDialog(Window owner, Doc doc) : base(owner, "Esporta audio", 520)
    {
        this.doc = doc;
        source = doc.ArrView && doc.ArrBars.Count > 0 ? "arr" : "pattern";
        Body.Children.Add(opts);
        Body.Children.Add(bar);
        status.Margin = new Thickness(0, 6, 0, 0); status.TextWrapping = TextWrapping.Wrap;
        Body.Children.Add(status);
        go.Click += Run;
        cancel.Click += () => { if (cts != null) cts.Cancel(); else Close(); };
        Buttons(cancel, go);
        Closing += (_, _) => cts?.Cancel();
        Render();
    }

    void Row(string label, IEnumerable<(string id, string text, bool on, bool enabled)> items, Action<string> pick)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 4) };
        var l = Txt.Make(label, 11, Theme.Dim); l.Width = 110; l.VerticalAlignment = VerticalAlignment.Center;
        sp.Children.Add(l);
        foreach (var (id, text, on, en) in items)
        {
            var b = new Btn(text) { IsOn = on, Enabled = en };
            b.Click += () => { pick(id); Render(); };
            sp.Children.Add(b);
        }
        opts.Children.Add(sp);
    }

    void Render()
    {
        opts.Children.Clear();
        int arrBars = doc.ArrBars.Count;
        int chain = (doc.Root["song"]?["chain"] as System.Text.Json.Nodes.JsonArray)?.Count ?? 0;
        Row("SORGENTE", new[]
        {
            ("pattern", $"Pattern P{doc.Slot + 1}", source == "pattern", true),
            ("arr", $"Arrangiamento ({arrBars} bar)", source == "arr", arrBars > 0),
            ("song", $"Song ({chain})", source == "song", chain > 0),
        }, v => source = v);
        if (source == "pattern") Row("RIPETIZIONI", new[] { 1, 2, 4, 8, 16 }.Select(n => (n.ToString(), $"×{n}", reps == n, true)), v => reps = int.Parse(v));
        Row("FORMATO", new[] { (16, "WAV 16 bit"), (24, "WAV 24 bit"), (32, "WAV 32 bit float") }.Select(x => (x.Item1.ToString(), x.Item2, bits == x.Item1, true)), v => bits = int.Parse(v));
        Row("FREQUENZA", new[] { 44100, 48000, 96000 }.Select(x => (x.ToString(), $"{x / 1000.0:0.#} kHz", rate == x, true)), v => rate = int.Parse(v));
        Row("FILE", new[] { ("mix", "Mix stereo", !stems, true), ("stems", "Stem (un file per traccia)", stems, true) }, v => stems = v == "stems");
        Row("LIVELLO", new[] { ("no", "Così com'è", !normalize, true), ("norm", "Normalizza a −0,3 dB", normalize, true) }, v => normalize = v == "norm");
        var parts = doc.Parts(null);
        long steps = Exporter.Steps(parts, Opt());
        double sec = steps * 15.0 / Math.Max(40, Doc.Num(doc.Pat, "bpm", 120)) + 2.5;
        status.Text = stems
            ? $"{Exporter.StemChannels(parts).Count} stem, circa {sec:0} s ciascuno, con gli effetti della traccia e del master."
            : $"Circa {sec:0} s (coda di 2,5 s compresa).";
    }

    Exporter.Options Opt() => new(source, reps, rate, bits, normalize);

    async void Run()
    {
        if (cts != null) return;
        var parts = doc.Parts(null);
        var o = Opt();
        string name = source == "pattern" ? $"P{doc.Slot + 1}" : source;
        var d = new Microsoft.Win32.SaveFileDialog { Filter = "Audio WAV (*.wav)|*.wav", FileName = $"drumbort-{name}-{(int)Doc.Num(doc.Pat, "bpm", 120)}bpm.wav" };
        if (d.ShowDialog(this) != true) return;
        string path = d.FileName;
        var list = stems ? Exporter.StemChannels(parts).Select(c => (int?)c).ToList() : new List<int?> { null };
        if (list.Count == 0) { status.Text = "Nessuna traccia con note da esportare."; return; }
        cts = new CancellationTokenSource();
        go.Enabled = false; cancel.Text = "Annulla"; bar.Visibility = Visibility.Visible;
        var names = list.ToDictionary(c => c ?? -1, c => c is int ch ? $"{doc.TrackShort(ch)}-{doc.TrackName(ch)}" : "");
        try
        {
            for (int i = 0; i < list.Count; i++)
            {
                int? ch = list[i];
                status.Text = ch is int c ? $"Stem {i + 1}/{list.Count}: {names[c]}…" : "Rendering…";
                int k = i;
                var prog = new Progress<double>(v => bar.Value = (k + v) / list.Count);
                string file = ch is int cc
                    ? Path.Combine(Path.GetDirectoryName(path)!, $"{Path.GetFileNameWithoutExtension(path)}-{k + 1:00}-{Safe(names[cc])}.wav")
                    : path;
                var token = cts.Token;
                await Task.Run(() =>
                {
                    var (l, r) = Exporter.Render(parts, o, ch, v => ((IProgress<double>)prog).Report(v), token);
                    if (o.Normalize) Exporter.Normalize(l, r);
                    Exporter.WriteWav(file, l, r, o.Rate, o.Bits);
                }, token);
            }
            status.Text = stems ? $"{list.Count} stem salvati in {Path.GetDirectoryName(path)}" : $"Salvato: {path}";
            bar.Value = 1;
        }
        catch (OperationCanceledException) { status.Text = "Export annullato."; }
        catch (Exception x) { status.Text = "Export non riuscito: " + x.Message; }
        finally { cts = null; go.Enabled = true; cancel.Text = "Chiudi"; }
    }
    static string Safe(string s) => string.Concat(s.Select(c => char.IsLetterOrDigit(c) ? c : '_')).Trim('_');
}
