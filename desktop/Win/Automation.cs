// Automation.cs — Editor dell'automazione per step (stesso formato di js/automation.js).
//
// pattern.auto = { "<bersaglio>": [valore 0..1 | null] × step del pattern }
//   d0..d7.(vol|pan|tune|decay|rev|dly)  s0..s3.(vol|pan|cut|res|rev|dly)  fx.filter
//
// Si disegna col mouse (sinistro = valore, destro = cancella), con forme rapide come i clip
// di automazione di FL Studio: rampa, sinusoide, onda quadra, casuale.

using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace DrumBort.Win;

public static class AutoParams
{
    public static readonly Dictionary<string, (string label, Func<double, double> from, Func<double, string> fmt)> P = new()
    {
        ["vol"] = ("Volume", x => x, v => $"{Math.Round(v * 100)}"),
        ["pan"] = ("Pan", x => (x + 1) / 2, v => v < 0.49 ? $"L{Math.Round((0.5 - v) * 200)}" : v > 0.51 ? $"R{Math.Round((v - 0.5) * 200)}" : "C"),
        ["tune"] = ("Tune", x => (x + 12) / 24, v => $"{Math.Round(v * 24 - 12):+0;-0;0} st"),
        ["decay"] = ("Decay", x => (x - 0.2) / 2.3, v => $"{0.2 + v * 2.3:0.00}"),
        ["rev"] = ("Riverbero", x => x, v => $"{Math.Round(v * 100)}"),
        ["dly"] = ("Delay", x => x, v => $"{Math.Round(v * 100)}"),
        ["cut"] = ("Cutoff", x => (x + 1) / 2, v => $"{Math.Round((v * 2 - 1) * 100):+0;-0;0}"),
        ["res"] = ("Risonanza", x => (x + 1) / 2, v => $"{Math.Round((v * 2 - 1) * 100):+0;-0;0}"),
        ["filter"] = ("Filtro master", x => (x + 1) / 2, v => v < 0.49 ? $"LP {Math.Round((0.5 - v) * 200)}" : v > 0.51 ? $"HP {Math.Round((v - 0.5) * 200)}" : "OFF"),
    };
    public static readonly string[] Drum = { "vol", "pan", "tune", "decay", "rev", "dly" };
    public static readonly string[] Syn = { "vol", "pan", "cut", "res", "rev", "dly" };

    public static string Prefix(int ch) => ch < 8 ? $"d{ch}" : $"s{ch - 8}";
    public static IEnumerable<string> Keys(int ch) => (ch < 8 ? Drum : Syn).Select(p => $"{Prefix(ch)}.{p}");
    public static string Param(string key) => key[(key.IndexOf('.') + 1)..];
}

/// <summary>Pannello: barra (bersaglio, forme, cancella) e area di disegno.</summary>
public sealed class AutomationView : DockPanel
{
    readonly Doc doc;
    readonly AutoLane lane;
    readonly Dropdown target = new(220);
    readonly TextBlock info = Txt.Make("", 11, Theme.Dim);
    public int Ch = -1;
    string key = "";

    public AutomationView(Doc doc)
    {
        this.doc = doc;
        Background = Theme.Panel;
        lane = new AutoLane(doc) { Margin = new Thickness(8, 4, 8, 8) };
        lane.Hover += s => info.Text = s;
        var bar = new WrapPanel { Margin = new Thickness(8, 6, 8, 2) };
        DockPanel.SetDock(bar, Dock.Top);
        bar.Children.Add(Txt.Make("AUTOMAZIONE", 11, Theme.Orange, true));
        bar.Children.Add(new Border { Width = 10 });
        target.ToolTip = "Parametro da automatizzare (● = ha un'automazione)";
        target.Changed += k => { key = k; lane.Key = k; lane.InvalidateVisual(); };
        bar.Children.Add(target);
        bar.Children.Add(new Border { Width = 10 });
        foreach (var (lbl, shape, tip) in new (string, string, string)[]
        {
            ("↗", "up", "Rampa crescente"), ("↘", "down", "Rampa decrescente"), ("∿", "sine", "Sinusoide (1 ciclo per battuta)"),
            ("⊓", "square", "Onda quadra (mezza battuta)"), ("⁂", "rand", "Valori casuali"),
        })
        {
            var b = new Btn(lbl, 30, tip);
            b.Click += () => Shape(shape);
            bar.Children.Add(b);
        }
        var clr = new Btn("CANCELLA", 0, "Toglie l'automazione di questo parametro");
        clr.Click += Clear;
        bar.Children.Add(clr);
        bar.Children.Add(new Border { Width = 12 });
        bar.Children.Add(info);
        Children.Add(bar);
        Children.Add(lane);
    }

    public void Render()
    {
        if (Ch < 0) { target.SetItems(Array.Empty<(string, string)>()); lane.Key = ""; lane.InvalidateVisual(); return; }
        var keys = AutoParams.Keys(Ch).Append("fx.filter").ToList();
        var auto = doc.Pat["auto"] as JsonObject;
        target.SetItems(keys.Select(k => (k, (auto?[k] is JsonArray a && a.Any(v => v != null) ? "● " : "") + (k == "fx.filter" ? "Master · " : doc.TrackShort(Ch) + " · ") + AutoParams.P[AutoParams.Param(k)].label)));
        if (!keys.Contains(key)) key = keys.FirstOrDefault(k => auto?[k] is JsonArray) ?? keys[0];
        target.Value = key;
        lane.Key = key; lane.Ch = Ch;
        info.Text = "Sinistro: disegna · destro: cancella · Shift: linea retta";
        lane.InvalidateVisual();
    }

    public void SetPlayhead(int step) { if (lane.Playhead != step) { lane.Playhead = step; lane.InvalidateVisual(); } }

    void Shape(string shape)
    {
        if (key == "") return;
        int n = doc.StepCount;
        var rnd = new Random();
        doc.Snapshot();
        var a = new JsonArray();
        for (int s = 0; s < n; s++)
        {
            double t = s / (double)Math.Max(1, n - 1);
            double v = shape switch
            {
                "up" => t,
                "down" => 1 - t,
                "sine" => 0.5 + 0.5 * Math.Sin(2 * Math.PI * s / 16.0),
                "square" => s % 16 < 8 ? 1 : 0.15,
                _ => Math.Round(rnd.NextDouble(), 3),
            };
            a.Add(Math.Round(v, 4));
        }
        Lane()[key] = a;
        doc.Commit(doc.PatKey);
    }

    void Clear()
    {
        if (doc.Pat["auto"] is not JsonObject auto || !auto.ContainsKey(key)) return;
        doc.Snapshot();
        auto.Remove(key);
        doc.Commit(doc.PatKey);
    }

    JsonObject Lane()
    {
        if (doc.Pat["auto"] is not JsonObject auto) doc.Pat["auto"] = auto = new JsonObject();
        return auto;
    }
}

/// <summary>Area di disegno: una colonna per step, linea tratteggiata = valore della traccia.</summary>
public sealed class AutoLane : FrameworkElement
{
    readonly Doc doc;
    public string Key = "";
    public int Ch = -1;
    public int Playhead = -1;
    public event Action<string>? Hover;
    bool drawing, erasing;
    int last = -1; double lastV;
    Point? lineFrom;

    public AutoLane(Doc doc) { this.doc = doc; Cursor = Cursors.Pen; MinHeight = 80; }

    int N => doc.StepCount;
    JsonArray? Arr => doc.Pat["auto"]?[Key] as JsonArray;
    double? ValAt(int s) => Arr is JsonArray a && s < a.Count && a[s] != null ? Doc.Val(a[s]) : null;

    double BaseValue()
    {
        if (Key == "") return 0;
        string who = Key[..Key.IndexOf('.')], p = AutoParams.Param(Key);
        double x;
        if (who == "fx") x = Doc.Num(doc.Root["fx"], "filter", 0);
        else x = Doc.Num(Doc.TrackOf(doc.Pat, who[0] == 'd' ? int.Parse(who[1..]) : 8 + int.Parse(who[1..])), p, p == "decay" ? 1 : p == "vol" ? 0.8 : 0);
        return Math.Clamp(AutoParams.P[p].from(x), 0, 1);
    }

    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, h = ActualHeight;
        dc.DrawRectangle(Theme.Bg, null, new Rect(0, 0, w, h));
        if (Key == "") return;
        int n = N; double cw = w / n;
        var col = Ch >= 0 ? Theme.Track(Ch) : Theme.Orange;
        var c = ((SolidColorBrush)col).Color;
        var fill = new SolidColorBrush(Color.FromArgb(170, c.R, c.G, c.B));
        for (int s = 0; s < n; s++)
        {
            if ((s / 4) % 2 == 1) dc.DrawRectangle(Theme.Panel, null, new Rect(s * cw, 0, cw, h));
            if (s % 16 == 0) dc.DrawRectangle(Theme.Panel3, null, new Rect(s * cw, 0, 1, h));
            if (ValAt(s) is double v)
            {
                double y = (1 - v) * (h - 4) + 2;
                dc.DrawRectangle(fill, null, new Rect(s * cw + 1, y, Math.Max(1, cw - 2), h - y));
                dc.DrawRectangle(col, null, new Rect(s * cw + 1, y - 1, Math.Max(1, cw - 2), 3));
            }
            if (s == Playhead) dc.DrawRectangle(null, new Pen(Theme.Orange, 2), new Rect(s * cw + 1, 1, Math.Max(1, cw - 2), h - 2));
        }
        double by = (1 - BaseValue()) * (h - 4) + 2;
        dc.DrawLine(new Pen(Theme.Dim, 1) { DashStyle = DashStyles.Dash }, new Point(0, by), new Point(w, by));
    }

    int CellAt(Point p) => Math.Clamp((int)(p.X / Math.Max(1, ActualWidth / N)), 0, N - 1);
    double ValueAt(Point p) => Math.Round(Math.Clamp(1 - (p.Y - 2) / Math.Max(1, ActualHeight - 4), 0, 1), 4);

    JsonArray Ensure()
    {
        if (doc.Pat["auto"] is not JsonObject auto) doc.Pat["auto"] = auto = new JsonObject();
        if (auto[Key] is not JsonArray a || a.Count != N)
        {
            var old = auto[Key] as JsonArray;
            a = new JsonArray(Enumerable.Range(0, N).Select(i => old != null && old.Count > 0 ? old[i % old.Count]?.DeepClone() : null).ToArray());
            auto[Key] = a;
        }
        return a;
    }

    void Put(int s, double? v)
    {
        var a = Ensure();
        a[s] = v is double d ? JsonValue.Create(d) : null;
    }

    protected override void OnMouseDown(MouseButtonEventArgs e)
    {
        if (Key == "") return;
        var p = e.GetPosition(this);
        doc.Snapshot();
        erasing = e.ChangedButton == MouseButton.Right;
        drawing = true;
        if (Keyboard.Modifiers.HasFlag(ModifierKeys.Shift) && !erasing) lineFrom = p; else lineFrom = null;
        last = CellAt(p); lastV = ValueAt(p);
        Put(last, erasing ? null : lastV);
        CaptureMouse();
        InvalidateVisual();
        doc.CommitQuiet(doc.PatKey);
        e.Handled = true;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        var p = e.GetPosition(this);
        if (Key != "")
        {
            int s = CellAt(p);
            Hover?.Invoke($"Step {s + 1}: {(ValAt(s) is double v ? AutoParams.P[AutoParams.Param(Key)].fmt(v) : "—")}");
        }
        if (!drawing) return;
        int c = CellAt(p); double val = ValueAt(p);
        if (lineFrom is Point f)
        {
            // Linea retta dal punto iniziale (Shift)
            int c0 = CellAt(f); double v0 = ValueAt(f);
            int a = Math.Min(c0, c), b = Math.Max(c0, c);
            for (int i = a; i <= b; i++) Put(i, b == a ? val : Math.Round(v0 + (val - v0) * (i - c0) / (double)(c - c0), 4));
        }
        else
        {
            // Interpola le celle saltate da un movimento veloce
            int a = Math.Min(last, c), b = Math.Max(last, c);
            for (int i = a; i <= b; i++)
                Put(i, erasing ? null : b == a ? val : Math.Round(lastV + (val - lastV) * (i - last) / (double)(c - last), 4));
        }
        last = c; lastV = val;
        InvalidateVisual();
        doc.CommitQuiet(doc.PatKey);
    }

    protected override void OnMouseUp(MouseButtonEventArgs e)
    {
        if (!drawing) return;
        drawing = false;
        ReleaseMouseCapture();
        // Corsia vuota: tolta del tutto
        if (doc.Pat["auto"] is JsonObject auto && auto[Key] is JsonArray a && a.All(v => v == null)) auto.Remove(Key);
        doc.Commit(doc.PatKey);
    }
}
