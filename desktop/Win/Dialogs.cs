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
