// Players.cs — Drummer e Session Player (come in Logic Pro): si sceglie uno stile e si muove il
// pad XY (semplice ↔ complesso, morbido ↔ forte); il pattern si rigenera mentre suona.
// Drummer: le 8 voci della batteria. Session Player: basso o accordi sulla traccia synth
// selezionata, da una progressione di accordi nella scala del pattern.

using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace DrumBort.Win;

/// <summary>Pad XY: X = complessità, Y = intensità (in alto = forte).</summary>
public sealed class XYPad : FrameworkElement
{
    public double X = 0.4, Y = 0.5;
    public string LabelX0 = "Semplice", LabelX1 = "Complesso", LabelY0 = "Morbido", LabelY1 = "Forte";
    public event Action? Changed, Released;
    bool drag;
    public XYPad() { Width = 220; Height = 220; Cursor = Cursors.Hand; }
    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, h = ActualHeight;
        dc.DrawRoundedRectangle(new LinearGradientBrush(Color.FromRgb(0x2a, 0x31, 0x37), Color.FromRgb(0x3a, 0x30, 0x24), 45), new Pen(Theme.Edge, 1), new Rect(0, 0, w, h), 6, 6);
        for (int i = 1; i < 4; i++)
        {
            dc.DrawLine(new Pen(Theme.Panel3, 0.5), new Point(w * i / 4, 0), new Point(w * i / 4, h));
            dc.DrawLine(new Pen(Theme.Panel3, 0.5), new Point(0, h * i / 4), new Point(w, h * i / 4));
        }
        var dpi = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        FormattedText T(string s) => new(s, System.Globalization.CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface(Theme.Font.Source), 10, Theme.Dim, dpi);
        dc.DrawText(T(LabelX0), new Point(6, h / 2 - 7));
        var x1 = T(LabelX1); dc.DrawText(x1, new Point(w - x1.Width - 6, h / 2 - 7));
        var y1 = T(LabelY1); dc.DrawText(y1, new Point(w / 2 - y1.Width / 2, 4));
        var y0 = T(LabelY0); dc.DrawText(y0, new Point(w / 2 - y0.Width / 2, h - 16));
        var p = new Point(X * w, (1 - Y) * h);
        dc.DrawEllipse(new SolidColorBrush(Color.FromArgb(60, 255, 155, 61)), null, p, 18, 18);
        dc.DrawEllipse(Theme.Orange, new Pen(Brushes.White, 2), p, 8, 8);
    }
    void SetFrom(Point p)
    {
        X = Math.Clamp(p.X / ActualWidth, 0, 1); Y = Math.Clamp(1 - p.Y / ActualHeight, 0, 1);
        InvalidateVisual(); Changed?.Invoke();
    }
    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e) { drag = true; CaptureMouse(); SetFrom(e.GetPosition(this)); }
    protected override void OnMouseMove(MouseEventArgs e) { if (drag) SetFrom(e.GetPosition(this)); }
    protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e) { if (!drag) return; drag = false; ReleaseMouseCapture(); Released?.Invoke(); }
}

/// <summary>Generatori deterministici (stesso seme = stesso risultato).</summary>
public static class Players
{
    // Pesi per step (0-9) di ogni voce: 9 = sempre, valori bassi = solo con complessità alta.
    // Voci: 0 BD, 1 SD, 2 CP, 3 CH, 4 OH, 5 TM, 6 CY/RD, 7 percussione
    public static readonly (string id, string name, string[] w, int swing)[] DrumStyles =
    {
        ("pop", "Pop", new[] { "9000003090300000", "0000900000009002", "0000000000000000", "9070907090709070", "0000000000000060", "0000000000000003", "5000000000000000", "0000000000000000" }, 50),
        ("rock", "Rock", new[] { "9000006090500030", "0000900200009000", "0000000000000000", "9050905090509050", "0000000000000040", "0000000000000357", "8000000000000000", "0000000000000000" }, 50),
        ("house", "House", new[] { "9000900090009000", "0000000000000000", "0000900000009000", "3535353535353535", "0090009000900090", "0000000000000000", "0000000000000000", "0030000300300003" }, 54),
        ("hiphop", "Hip hop", new[] { "9000000940900000", "0000900003009000", "0000500000005000", "9060906090609060", "0000000000000050", "0000000000000000", "0000000000000000", "0000000300000030" }, 62),
        ("trap", "Trap", new[] { "9000000900900050", "0000000090000000", "0000000090000000", "9595959595959595", "0000000000000000", "0000000000000040", "0000000000000000", "0000003000000300" }, 50),
        ("techno", "Techno", new[] { "9000900090009000", "0000000000000000", "0000500000005000", "0090009000900090", "0000000000000000", "0000000000000000", "3333333333333333", "0003000000030300" }, 50),
        ("dnb", "Drum & bass", new[] { "9000000000900000", "0000900000009000", "0000000000000000", "9090909090909090", "0000000000000500", "0000000000000000", "5000000000000000", "0030000300000300" }, 50),
        ("dembow", "Dembow", new[] { "9000900090009000", "0009009000090090", "0000000000000000", "9050905090509050", "0000000000000000", "0000000000000000", "0000000000000000", "0000000000000000" }, 52),
    };

    /// <summary>Batteria: complessità c, intensità i (0-1), voci attive, fill sull'ultima battuta.</summary>
    public static void Drums(JsonObject pat, string style, double c, double i, bool[] voices, double fill, int seed)
    {
        var st = DrumStyles.FirstOrDefault(s => s.id == style);
        if (st.w == null) st = DrumStyles[0];
        var r = new Random(seed);
        int bars = Doc.Num(pat, "bars", 1) is var b && (b == 2 || b == 4) ? (int)b : 1, n = 16 * bars;
        var steps = (JsonArray)pat["steps"]!; var opts = (JsonArray)pat["opts"]!;
        double thr = 9 - c * 8;                  // peso minimo per suonare
        for (int t = 0; t < 8; t++)
        {
            if (!voices[t]) continue;
            var row = new JsonArray(); var orow = new JsonArray();
            for (int s = 0; s < n; s++)
            {
                int w = st.w[t][s % 16] - '0';
                // Variazione: con la complessità alcuni colpi deboli si spostano o compaiono a caso
                double jitter = (r.NextDouble() - 0.5) * 2 * c;
                bool on = w > 0 && w + jitter >= thr;
                if (!on && t is 3 or 7 && c > 0.75 && r.NextDouble() < (c - 0.75) * 0.6) on = true;
                // Intensità bassa: niente piatti, meno open hat
                if (on && t == 6 && i < 0.45) on = false;
                if (on && t == 4 && i < 0.25) on = false;
                int v = on ? (w >= 9 && i > 0.55 || (t == 0 && s % 16 == 0) ? 2 : 1) : 0;
                JsonNode? o = null;
                if (on)
                {
                    double vel = Math.Clamp((0.4 + 0.55 * i) * (0.65 + 0.35 * w / 9.0) + (r.NextDouble() - 0.5) * 0.08, 0.1, 1);
                    var oo = new JsonObject { ["pl"] = new JsonObject { ["vel"] = Math.Round(vel, 3) } };
                    // Trap: rullate di hi-hat (ripetizioni) con la complessità
                    if (style == "trap" && t == 3 && c > 0.4 && r.NextDouble() < (c - 0.3) * 0.5) oo["r"] = r.Next(2, 5);
                    // Ghost note del rullante più leggere
                    if (t == 1 && w < 5) ((JsonObject)oo["pl"]!)["vel"] = Math.Round(vel * 0.45, 3);
                    o = oo;
                }
                row.Add(v); orow.Add(o);
            }
            // Fill sull'ultimo quarto del pattern: rullante e tom in crescendo
            if (fill > 0 && (t == 1 || t == 5))
                for (int s = n - 4; s < n; s++)
                    if (r.NextDouble() < fill * (t == 1 ? 0.9 : 0.6))
                    {
                        row[s] = s == n - 1 ? 2 : 1;
                        orow[s] = new JsonObject { ["pl"] = new JsonObject { ["vel"] = Math.Round(Math.Clamp(0.5 + 0.12 * (s - n + 4) + 0.3 * i, 0.1, 1), 3) } };
                    }
            steps[t] = row; opts[t] = orow;
            ((JsonObject)pat["tracks"]![t]!)["len"] = n;
        }
        pat["swing"] = st.swing;
    }

    public static readonly (string id, string name, int[] degs)[] Progressions =
    {
        ("i-VI-III-VII", "i – VI – III – VII", new[] { 0, 5, 2, 6 }), ("I-V-vi-IV", "I – V – vi – IV", new[] { 0, 4, 5, 3 }),
        ("ii-V-I", "ii – V – I – I", new[] { 1, 4, 0, 0 }), ("i-iv-v", "i – iv – v – i", new[] { 0, 3, 4, 0 }),
        ("i-VII-VI", "i – VII – VI – VII", new[] { 0, 6, 5, 6 }), ("pedal", "i (pedale)", new[] { 0, 0, 0, 0 }),
    };
    public static readonly (string id, string name)[] BassStyles = { ("root", "Tonica"), ("octave", "Ottave"), ("groove", "Groove"), ("walk", "Walking") };
    public static readonly (string id, string name)[] KeyStyles = { ("pad", "Accordi lunghi"), ("stab", "Stab"), ("arp", "Arpeggio"), ("comp", "Comping") };

    /// <summary>Note di una traccia synth: un accordo della progressione ogni `per` step.</summary>
    public static void Session(Doc doc, int ch, string prog, string style, double c, double i, int chordsPerBar, int seed)
    {
        var pat = doc.Pat;
        var syn = pat["synth"];
        var iv = Scales.Of(Doc.Str(syn, "scale", "minor"));
        int L = iv.Length, root = doc.Base(ch - 8);
        var degs = Progressions.FirstOrDefault(p => p.id == prog).degs ?? Progressions[0].degs;
        var r = new Random(seed);
        int n = doc.StepCount, per = Math.Max(4, 16 / Math.Max(1, chordsPerBar));
        var a = new JsonArray(Enumerable.Range(0, n).Select(_ => (JsonNode?)null).ToArray());
        int Note(int deg) => root + 12 * (int)Math.Floor(deg / (double)L) + iv[((deg % L) + L) % L];
        bool bass = Doc.Mono(ch - 8);
        int A(bool strong) => strong && i > 0.5 ? 1 : 0;
        for (int start = 0, k = 0; start < n; start += per, k++)
        {
            int d = degs[k % degs.Length];
            int rootN = Note(d), third = Note(d + 2), fifth = Note(d + 4);
            int[] chord = { 0, third - rootN, fifth - rootN };
            if (c > 0.6) chord = chord.Append(Note(d + 6) - rootN).ToArray();      // settima
            void Put(int s, int note, int g, bool acc, int[]? ch2 = null, bool slide = false)
            {
                if (s >= n) return;
                a[s] = new JsonObject
                {
                    ["n"] = note, ["g"] = Math.Max(1, Math.Min(g, n - s)), ["a"] = A(acc), ["sl"] = slide ? 1 : 0,
                    ["ch"] = ch2 == null ? null : new JsonArray(ch2.Select(x => (JsonNode)x).ToArray()),
                    ["pl"] = new JsonObject { ["vel"] = Math.Round(Math.Clamp(0.45 + 0.5 * i + (r.NextDouble() - 0.5) * 0.1, 0.1, 1), 3) },
                };
            }
            if (bass)
            {
                int b = rootN - 12 >= 28 ? rootN - 12 : rootN;
                switch (style)
                {
                    case "root":
                        Put(start, b, c < 0.3 ? per : per / 2, true);
                        if (c >= 0.3) Put(start + per / 2, b, per / 2 - 1, false);
                        break;
                    case "octave":
                        for (int s = 0; s < per; s += 2) Put(start + s, s % 4 == 0 ? b : b + 12, 1, s == 0, null, c > 0.7 && r.NextDouble() < 0.2);
                        break;
                    case "walk":
                        for (int s = 0; s < per; s += 4) Put(start + s, s == 0 ? b : Note(d + (s / 4) % 3 * (r.NextDouble() < 0.5 ? 1 : 2)) - 12, 3, s == 0);
                        break;
                    default:   // groove: sincopi crescenti con la complessità
                        int[] grid = { 0, 3, 6, 8, 10, 11, 14 };
                        foreach (int s in grid.Where(s => s < per))
                        {
                            if (s != 0 && r.NextDouble() > 0.25 + c * 0.7) continue;
                            int note = s == 0 ? b : r.NextDouble() < 0.3 + c * 0.3 ? (r.NextDouble() < 0.5 ? b + 12 : Note(d + 4) - 12) : b;
                            Put(start + s, note, s == 0 ? 2 : 1, s == 0, null, c > 0.6 && r.NextDouble() < 0.15);
                        }
                        break;
                }
            }
            else
            {
                switch (style)
                {
                    case "stab":
                        foreach (int s in new[] { 0, 3, 6, 10, 12, 14 }.Where(s => s < per))
                            if (s == 0 || r.NextDouble() < 0.2 + c * 0.6) Put(start + s, rootN, 1, s == 0, chord);
                        break;
                    case "arp":
                    {
                        var tones = chord.Select(x => rootN + x).Concat(c > 0.5 ? new[] { rootN + 12 } : Array.Empty<int>()).ToArray();
                        int stepLen = c > 0.5 ? 1 : 2;
                        for (int s = 0, j = 0; s < per; s += stepLen, j++) Put(start + s, tones[j % tones.Length], stepLen, s == 0);
                        break;
                    }
                    case "comp":
                        Put(start, rootN, 3, true, chord);
                        if (per >= 8) Put(start + per / 2 + (c > 0.5 ? -1 : 0), rootN, 2, false, chord);
                        if (c > 0.4 && per >= 16) Put(start + 14, rootN, 1, false, chord);
                        break;
                    default:   // pad
                        Put(start, rootN, per, true, chord);
                        break;
                }
            }
        }
        var tr = doc.Track(ch);
        tr["steps"] = a;
        tr["len"] = n;
    }
}

/// <summary>Finestra Drummer / Session Player: modifica il pattern corrente dal vivo (Annulla ripristina).</summary>
public sealed class PlayersDialog : DarkDialog
{
    readonly Doc doc;
    bool drummer;
    int synthCh;
    readonly XYPad pad = new();
    readonly StackPanel opts = new() { Margin = new Thickness(14, 0, 0, 0), Width = 330 };
    string dStyle = "pop", prog = "i-VI-III-VII", sStyle = "groove";
    readonly bool[] voices = Enumerable.Repeat(true, 8).ToArray();
    double fill = 0.3;
    int perBar = 1, seed = 1;
    bool applied;

    public PlayersDialog(Window owner, Doc doc, int selCh) : base(owner, "Drummer e Session Player", 640)
    {
        this.doc = doc;
        drummer = selCh < 8;
        synthCh = selCh >= 8 ? selCh : doc.Tracks.FirstOrDefault(t => t >= 8, 8);
        sStyle = Doc.Mono(synthCh - 8) ? "groove" : "pad";
        var tabs = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 10) };
        var tD = new Btn("🥁 DRUMMER") { IsOn = drummer }; var tS = new Btn("🎹 SESSION PLAYER") { IsOn = !drummer };
        tD.Click += () => { drummer = true; tD.IsOn = true; tS.IsOn = false; Render(); };
        tS.Click += () => { drummer = false; tD.IsOn = false; tS.IsOn = true; Render(); };
        tabs.Children.Add(tD); tabs.Children.Add(tS);
        Body.Children.Add(tabs);
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        var left = new StackPanel();
        left.Children.Add(pad);
        var regen = new Btn("⟳ RIGENERA", 0, "Un'altra variante con le stesse impostazioni") { Margin = new Thickness(0, 8, 0, 0) };
        regen.Click += () => { seed++; Apply(false); };
        left.Children.Add(regen);
        row.Children.Add(left);
        row.Children.Add(opts);
        Body.Children.Add(row);
        pad.Changed += () => Apply(true);
        pad.Released += () => Apply(false);
        var cancel = new Btn("Annulla"); var ok = new Btn("Applica") { IsOn = true };
        cancel.Click += () => { Revert(); Close(); };
        ok.Click += () => { doc.Commit(doc.PatKey, "tracks"); applied = false; DialogResult = true; };
        Buttons(cancel, ok);
        Closing += (_, _) => { if (applied && DialogResult != true) Revert(); };
        doc.Snapshot();
        Render();
    }

    void Revert() { if (applied) { applied = false; doc.Undo(); } }

    void Choice<T>(string label, IEnumerable<(T id, string name)> items, T cur, Action<T> set)
    {
        opts.Children.Add(new TextBlock { Text = label, FontSize = 10, Foreground = Theme.Dim, Margin = new Thickness(0, 8, 0, 2) });
        var wp = new WrapPanel();
        foreach (var (id, name) in items)
        {
            var b = new Btn(name) { IsOn = EqualityComparer<T>.Default.Equals(id, cur), Padding = new Thickness(6, 2, 6, 2) };
            var v = id;
            b.Click += () => { set(v); Render(); Apply(false); };
            wp.Children.Add(b);
        }
        opts.Children.Add(wp);
    }

    void Render()
    {
        opts.Children.Clear();
        if (drummer)
        {
            Choice("STILE", Players.DrumStyles.Select(s => (s.id, s.name)), dStyle, v => dStyle = v);
            opts.Children.Add(new TextBlock { Text = "VOCI", FontSize = 10, Foreground = Theme.Dim, Margin = new Thickness(0, 8, 0, 2) });
            var wp = new WrapPanel();
            for (int t = 0; t < 8; t++)
            {
                int tt = t;
                var b = new Btn(doc.Kit.Tracks[t].Short, 34) { IsOn = voices[t], Padding = new Thickness(2) };
                b.Click += () => { voices[tt] = !voices[tt]; b.IsOn = voices[tt]; Apply(false); };
                wp.Children.Add(b);
            }
            opts.Children.Add(wp);
            Choice("FILL A FINE PATTERN", new[] { (0.0, "No"), (0.3, "Pochi"), (0.7, "Tanti") }, fill, v => fill = v);
            opts.Children.Add(Txt.Make("Muovi il punto nel pad: a destra più colpi e variazioni, in alto più forte. Con la riproduzione attiva si sente subito.", 11, Theme.Dim));
        }
        else
        {
            Choice("TRACCIA", Enumerable.Range(8, 4).Select(c => (c, doc.TrackShort(c))), synthCh, v => { synthCh = v; sStyle = Doc.Mono(v - 8) ? "groove" : "pad"; });
            Choice("PROGRESSIONE (nella scala del pattern)", Players.Progressions.Select(p => (p.id, p.name)), prog, v => prog = v);
            Choice(Doc.Mono(synthCh - 8) ? "STILE DEL BASSO" : "STILE DEGLI ACCORDI", Doc.Mono(synthCh - 8) ? Players.BassStyles : Players.KeyStyles, sStyle, v => sStyle = v);
            Choice("ACCORDI PER BATTUTA", new[] { (1, "1"), (2, "2") }, perBar, v => perBar = v);
            opts.Children.Add(Txt.Make("Tonica e scala si cambiano nell'EDITOR della traccia synth.", 11, Theme.Dim));
        }
        foreach (var t in opts.Children.OfType<TextBlock>()) t.TextWrapping = TextWrapping.Wrap;
    }

    void Apply(bool quiet)
    {
        if (drummer)
        {
            Players.Drums(doc.Pat, dStyle, pad.X, pad.Y, voices, fill, seed);
            var add = Enumerable.Range(0, 8).Where(t => voices[t] && ((JsonArray)doc.Pat["steps"]![t]!).Any(v => Doc.Val(v) > 0));
            doc.SetTracks(doc.Tracks.Concat(add).OrderBy(x => x));
            foreach (int t in add) doc.SetAll(t, "mute", false);
        }
        else
        {
            Players.Session(doc, synthCh, prog, sStyle, pad.X, pad.Y, perBar, seed);
            if (!doc.Tracks.Contains(synthCh)) { doc.SetTracks(doc.Tracks.Append(synthCh)); doc.SetAll(synthCh, "mute", false); }
        }
        applied = true;
        var keys = doc.AllPatKeys.Append("tracks").ToArray();
        if (quiet) doc.CommitQuiet(keys); else doc.Commit(keys);
    }
}
