// Editors.cs — Editor del pannello EDITOR (come il Channel Rack e il Piano roll di FL Studio):
//   • graph editor per step: velocity, intonazione, decay, probabilità, ripetizioni, spostamento
//     (batteria) e velocity, cutoff, decay (synth), negli stessi campi della web app (opts, pl);
//   • lunghezza degli step per traccia (poliritmi, es. 12 contro 16);
//   • strumenti del piano roll: scala e tonica, trasposizione, chop, glue, legato, umanizza, riff.

using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using DrumBort.Engine;

namespace DrumBort.Win;

public static class Scales
{
    public static readonly (string id, string name, int[] iv)[] All =
    {
        ("minor", "Minore", new[] { 0, 2, 3, 5, 7, 8, 10 }), ("major", "Maggiore", new[] { 0, 2, 4, 5, 7, 9, 11 }),
        ("dorian", "Dorica", new[] { 0, 2, 3, 5, 7, 9, 10 }), ("phrygian", "Frigia", new[] { 0, 1, 3, 5, 7, 8, 10 }),
        ("mixolydian", "Misolidia", new[] { 0, 2, 4, 5, 7, 9, 10 }), ("harmonic", "Minore armonica", new[] { 0, 2, 3, 5, 7, 8, 11 }),
        ("pentaMinor", "Pentatonica min.", new[] { 0, 3, 5, 7, 10 }), ("pentaMajor", "Pentatonica magg.", new[] { 0, 2, 4, 7, 9 }),
        ("blues", "Blues", new[] { 0, 3, 5, 6, 7, 10 }),
    };
    public static readonly string[] Keys = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };
    public static int[] Of(string id) => All.FirstOrDefault(s => s.id == id).iv ?? All[0].iv;
    /// <summary>La nota (classe 0-11) appartiene alla scala del pattern?</summary>
    public static bool In(Doc doc, int pitch)
    {
        var syn = doc.Pat["synth"];
        int key = (int)Doc.Num(syn, "key", 9);
        return Of(Doc.Str(syn, "scale", "minor")).Contains(((pitch - key) % 12 + 12) % 12);
    }
}

/// <summary>
/// Graph editor: una barra per step del valore scelto. Sinistro disegna, destro riporta al valore
/// della traccia (toglie il parameter lock), Shift = linea retta.
/// </summary>
public sealed class GraphLane : FrameworkElement
{
    public sealed record Param(string Id, string Label, double Min, double Max, double Def, Func<double, string> Fmt, bool Int = false);
    public static readonly Param[] Drum =
    {
        new("vel", "Velocity", 0.1, 1, 0.62, v => $"{Math.Round(v * 100)}"),
        new("tune", "Intonazione", -12, 12, 0, v => $"{v:+0;-0;0} st", true),
        new("decay", "Decay", 0.2, 2.5, 1, v => $"×{v:0.00}"),
        new("p", "Probabilità", 0, 100, 100, v => $"{v:0} %", true),
        new("r", "Ripetizioni", 1, 4, 1, v => $"×{v:0}", true),
        new("n", "Spostamento", -50, 50, 0, v => $"{v:+0;-0;0} %", true),
    };
    public static readonly Param[] Syn =
    {
        new("vel", "Velocity", 0.1, 1, 0.7, v => $"{Math.Round(v * 100)}"),
        new("cut", "Cutoff", -1, 1, 0, v => $"{v:+0.00;-0.00;0}"),
        new("dec", "Decay", 0.25, 3, 1, v => $"×{v:0.00}"),
    };

    readonly Doc doc;
    public int Ch;
    public Param P;
    public int Playhead = -1;
    public event Action<string>? Hover;
    bool drawing, reset;
    int last = -1; double lastV;
    Point? from;

    public GraphLane(Doc doc, int ch)
    {
        this.doc = doc; Ch = ch; P = Doc.IsSynth(ch) ? Syn[0] : Drum[0];
        MinHeight = 70; Cursor = Cursors.Pen;
    }

    int N => doc.StepCount;
    bool Synth => Doc.IsSynth(Ch);
    bool Plock => P.Id is "vel" or "tune" or "decay" or "cut" or "dec";

    /// <summary>Lo step suona? (colpo di batteria o nota synth)</summary>
    bool Hit(int s)
    {
        if (Synth) return Doc.TrackOf(doc.Pat, Ch)["steps"] is JsonArray a && s < a.Count && a[s] is JsonObject;
        return doc.Pat["steps"]?[Ch] is JsonArray r && s < r.Count && Doc.Val(r[s]) > 0;
    }
    /// <summary>Valore impostato sullo step (null = quello della traccia).</summary>
    double? Get(int s)
    {
        JsonNode? o = Synth ? (Doc.TrackOf(doc.Pat, Ch)["steps"] as JsonArray)?[s] : (doc.Pat["opts"]?[Ch] as JsonArray) is JsonArray oa && s < oa.Count ? oa[s] : null;
        if (o is not JsonObject obj) return null;
        var src = Plock ? obj["pl"] : obj;
        return src?[P.Id] is JsonNode v && J.TryD(v, out double d) ? d : null;
    }
    /// <summary>Valore mostrato quando lo step non ha un valore proprio.</summary>
    double Default(int s)
    {
        if (P.Id == "vel")
        {
            if (Synth) return (Doc.TrackOf(doc.Pat, Ch)["steps"] as JsonArray)?[s] is JsonObject st && Doc.Num(st, "a", 0) > 0 ? 1 : 0.7;
            return doc.Pat["steps"]?[Ch] is JsonArray r && s < r.Count && Doc.Val(r[s]) == 2 ? 1 : 0.62;
        }
        return P.Def;
    }

    void Set(int s, double? v)
    {
        JsonObject? obj;
        if (Synth)
        {
            obj = (Doc.TrackOf(doc.Pat, Ch)["steps"] as JsonArray)?[s] as JsonObject;
            if (obj == null) return;        // senza nota non c'è niente da modificare
        }
        else
        {
            var opts = (JsonArray)doc.Pat["opts"]![Ch]!;
            while (opts.Count <= s) opts.Add(null);
            obj = opts[s] as JsonObject;
            if (obj == null) { if (v == null) return; opts[s] = obj = new JsonObject(); }
        }
        if (Plock)
        {
            if (obj["pl"] is not JsonObject pl) { if (v == null) return; obj["pl"] = pl = new JsonObject(); }
            if (v is double d) pl[P.Id] = d; else pl.Remove(P.Id);
            if (pl.Count == 0) obj.Remove("pl");
        }
        else if (v is double d) obj[P.Id] = (int)Math.Round(d); else obj.Remove(P.Id);
        // Opzioni della batteria tutte ai valori iniziali: si torna a null (come la web app)
        if (!Synth && Doc.Num(obj, "p", 100) == 100 && Doc.Num(obj, "r", 1) == 1 && Doc.Num(obj, "n", 0) == 0 && !Doc.Bool(obj, "f") && obj["pl"] == null)
            ((JsonArray)doc.Pat["opts"]![Ch]!)[s] = null;
    }

    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, h = ActualHeight, cw = w / N;
        dc.DrawRectangle(Theme.Bg, null, new Rect(0, 0, w, h));
        var col = ((SolidColorBrush)Theme.Track(Ch)).Color;
        var full = new SolidColorBrush(col); var faint = new SolidColorBrush(Color.FromArgb(70, col.R, col.G, col.B));
        bool bip = P.Min < 0 && P.Max > 0;
        double Y(double v) => 2 + (1 - (v - P.Min) / (P.Max - P.Min)) * (h - 4);
        double y0 = bip ? Y(0) : h - 2;
        for (int s = 0; s < N; s++)
        {
            if ((s / 4) % 2 == 1) dc.DrawRectangle(Theme.Panel, null, new Rect(s * cw, 0, cw, h));
            if (s % 16 == 0) dc.DrawRectangle(Theme.Panel3, null, new Rect(s * cw, 0, 1, h));
            bool hit = Hit(s);
            var v = Get(s);
            double val = v ?? Default(s);
            if (!hit && v == null) continue;
            double y = Y(val);
            var r = new Rect(s * cw + cw * 0.25, Math.Min(y, y0), Math.Max(2, cw * 0.5), Math.Max(2, Math.Abs(y0 - y)));
            dc.DrawRectangle(v != null ? full : faint, null, r);
            dc.DrawEllipse(v != null ? Brushes.White : faint, null, new Point(s * cw + cw / 2, y), 3, 3);
            if (s == Playhead) dc.DrawRectangle(null, new Pen(Theme.Orange, 1.5), new Rect(s * cw + 1, 1, cw - 2, h - 2));
        }
        if (bip) dc.DrawLine(new Pen(Theme.Dim, 0.5) { DashStyle = DashStyles.Dash }, new Point(0, y0), new Point(w, y0));
    }

    int Cell(Point p) => Math.Clamp((int)(p.X / Math.Max(1, ActualWidth / N)), 0, N - 1);
    double Value(Point p)
    {
        double f = Math.Clamp(1 - (p.Y - 2) / Math.Max(1, ActualHeight - 4), 0, 1);
        double v = P.Min + f * (P.Max - P.Min);
        return P.Int ? Math.Round(v) : Math.Round(v, 3);
    }

    protected override void OnMouseDown(MouseButtonEventArgs e)
    {
        var p = e.GetPosition(this);
        doc.Snapshot();
        reset = e.ChangedButton == MouseButton.Right;
        drawing = true;
        from = Keyboard.Modifiers.HasFlag(ModifierKeys.Shift) && !reset ? p : null;
        last = Cell(p); lastV = Value(p);
        Set(last, reset ? null : lastV);
        CaptureMouse(); InvalidateVisual();
        doc.CommitQuiet(doc.PatKey);
        e.Handled = true;
    }
    protected override void OnMouseMove(MouseEventArgs e)
    {
        var p = e.GetPosition(this);
        int c = Cell(p); double v = Value(p);
        Hover?.Invoke($"Step {c + 1}: {P.Fmt(Get(c) ?? Default(c))}");
        if (!drawing) return;
        int a0 = last; double v0 = lastV;
        if (from is Point f) { a0 = Cell(f); v0 = Value(f); }
        int lo = Math.Min(a0, c), hi = Math.Max(a0, c);
        for (int i = lo; i <= hi; i++)
        {
            double vi = hi == lo ? v : v0 + (v - v0) * (i - a0) / (double)(c - a0);
            Set(i, reset ? null : P.Int ? Math.Round(vi) : Math.Round(vi, 3));
        }
        last = c; lastV = v;
        InvalidateVisual();
        doc.CommitQuiet(doc.PatKey);
    }
    protected override void OnMouseUp(MouseButtonEventArgs e)
    {
        if (!drawing) return;
        drawing = false; ReleaseMouseCapture();
        doc.Commit(doc.PatKey);
    }
}

/// <summary>Pannello EDITOR: barra degli strumenti, note (step o piano roll) e graph editor.</summary>
public sealed class EditorPanel : DockPanel
{
    readonly Doc doc;
    public readonly int Ch;
    public readonly StepRow? Steps;
    public readonly PianoRoll? Roll;
    public readonly GraphLane Graph;
    readonly TextBlock hover = Txt.Make("", 11, Theme.Dim);
    static string lastDrumParam = "vel", lastSynParam = "vel";

    public EditorPanel(Doc doc, int ch, Action<UIElement>? rollHost = null)
    {
        this.doc = doc; Ch = ch;
        Background = Theme.Panel;
        bool syn = Doc.IsSynth(ch);
        var bar = new WrapPanel { Margin = new Thickness(8, 4, 8, 2) };
        DockPanel.SetDock(bar, Dock.Top);
        var title = Txt.Make($"P{doc.Slot + 1} · {doc.TrackShort(ch)} {doc.TrackName(ch)}", 12, Theme.Track(ch), true);
        title.VerticalAlignment = VerticalAlignment.Center; title.Margin = new Thickness(0, 0, 10, 0);
        bar.Children.Add(title);

        // Lunghezza della traccia (step), indipendente dalle altre
        var len = new Dropdown(84) { ToolTip = "Lunghezza della traccia in step: con lunghezze diverse le tracce girano sfasate (poliritmi)" };
        int n = doc.StepCount;
        len.SetItems(new[] { 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 24, 28, 32, 48, 64 }.Where(x => x <= n).Select(x => (x.ToString(), $"{x} step")));
        len.Value = ((int)Doc.Num(doc.Track(ch), "len", n)).ToString();
        len.Changed += v => { doc.Snapshot(); doc.Track(ch)["len"] = int.Parse(v); doc.Commit(doc.PatKey); };
        bar.Children.Add(len);

        if (syn) PianoTools(bar);
        Children.Add(bar);

        // Graph editor in basso
        Graph = new GraphLane(doc, ch) { Height = 80, Margin = new Thickness(8, 2, 8, 6) };
        var gbar = new WrapPanel { Margin = new Thickness(8, 2, 8, 0) };
        var ps = syn ? GraphLane.Syn : GraphLane.Drum;
        Graph.P = ps.FirstOrDefault(p => p.Id == (syn ? lastSynParam : lastDrumParam)) ?? ps[0];
        var tabs = new List<Btn>();
        foreach (var p in ps)
        {
            var b = new Btn(p.Label.ToUpperInvariant(), 0, $"Graph editor: {p.Label} per step (destro = valore della traccia)") { IsOn = p == Graph.P, Padding = new Thickness(6, 1, 6, 1), MinHeight = 20 };
            var pp = p;
            b.Click += () =>
            {
                Graph.P = pp;
                if (syn) lastSynParam = pp.Id; else lastDrumParam = pp.Id;
                foreach (var t in tabs) t.IsOn = t == b;
                Graph.InvalidateVisual();
            };
            tabs.Add(b); gbar.Children.Add(b);
        }
        hover.Margin = new Thickness(10, 0, 0, 0); hover.VerticalAlignment = VerticalAlignment.Center;
        gbar.Children.Add(hover);
        Graph.Hover += t => hover.Text = t;
        var gdock = new DockPanel();
        DockPanel.SetDock(gdock, Dock.Bottom);
        DockPanel.SetDock(gbar, Dock.Top);
        gdock.Children.Add(gbar); gdock.Children.Add(Graph);
        Children.Add(gdock);

        if (syn)
        {
            Roll = new PianoRoll(doc, ch);
            var sv = new ScrollViewer { Content = Roll, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Background = Theme.Bg };
            sv.Loaded += (_, _) => sv.Dispatcher.BeginInvoke(() => sv.ScrollToVerticalOffset(Math.Max(0, Roll.FocusY() - sv.ViewportHeight / 2)), System.Windows.Threading.DispatcherPriority.Loaded);
            Children.Add(sv);
        }
        else
        {
            Steps = new StepRow(doc, ch) { Height = 70, Margin = new Thickness(8, 4, 8, 4), VerticalAlignment = VerticalAlignment.Top };
            Children.Add(Steps);
        }
    }

    public void SetPlayhead(int step)
    {
        if (Steps != null && Steps.Playhead != step) { Steps.Playhead = step; Steps.InvalidateVisual(); }
        if (Roll != null && Roll.Playhead != step) { Roll.Playhead = step; Roll.InvalidateVisual(); }
        if (Graph.Playhead != step) { Graph.Playhead = step; Graph.InvalidateVisual(); }
    }
    public void Redraw() { Steps?.InvalidateVisual(); Roll?.InvalidateVisual(); Graph.InvalidateVisual(); }

    // ------------------------------------------------------------------ strumenti del piano roll
    JsonArray NoteSteps => (JsonArray)doc.Track(Ch)["steps"]!;

    void PianoTools(WrapPanel bar)
    {
        var syn = (JsonObject)doc.Pat["synth"]!;
        var key = new Dropdown(56) { ToolTip = "Tonica del pattern" };
        key.SetItems(Scales.Keys.Select((k, i) => (i.ToString(), k)));
        key.Value = ((int)Doc.Num(syn, "key", 9)).ToString();
        key.Changed += v => { doc.Snapshot(); syn["key"] = int.Parse(v); doc.Commit(doc.PatKey); };
        var scale = new Dropdown(130) { ToolTip = "Scala: le righe della scala sono evidenziate nel piano roll" };
        scale.SetItems(Scales.All.Select(s => (s.id, s.name)));
        scale.Value = Doc.Str(syn, "scale", "minor");
        scale.Changed += v => { doc.Snapshot(); syn["scale"] = v; doc.Commit(doc.PatKey); };
        bar.Children.Add(key); bar.Children.Add(scale);
        bar.Children.Add(new Border { Width = 10 });
        void Tool(string label, string tip, Action a)
        {
            var b = new Btn(label, 0, tip) { Padding = new Thickness(6, 1, 6, 1), MinHeight = 22 };
            b.Click += () => { doc.Snapshot(); a(); doc.Commit(doc.PatKey); };
            bar.Children.Add(b);
        }
        Tool("−12", "Trasponi un'ottava giù", () => Transpose(-12));
        Tool("−1", "Trasponi un semitono giù", () => Transpose(-1));
        Tool("+1", "Trasponi un semitono su", () => Transpose(1));
        Tool("+12", "Trasponi un'ottava su", () => Transpose(12));
        Tool("CHOP", "Divide le note lunghe in note da uno step", Chop);
        Tool("GLUE", "Unisce le note consecutive della stessa altezza", Glue);
        Tool("LEGATO", "Allunga ogni nota fino alla successiva", Legato);
        Tool("UMANIZZA", "Velocity leggermente diverse a ogni nota", Humanize);
        Tool("RIFF", "Genera una frase nella scala (come Riff Machine): ogni clic una variante", Riff);
        Tool("PULISCI", "Toglie tutte le note della traccia", () => { var a = NoteSteps; for (int i = 0; i < a.Count; i++) a[i] = null; });
    }

    void Transpose(int d)
    {
        foreach (var st in NoteSteps.OfType<JsonObject>()) st["n"] = Math.Clamp((int)Doc.Num(st, "n", 60) + d, 12, 108);
    }
    void Chop()
    {
        var a = NoteSteps;
        for (int s = 0; s < a.Count; s++)
            if (a[s] is JsonObject st && Doc.Num(st, "g", 1) > 1)
            {
                int g = (int)Doc.Num(st, "g", 1);
                st["g"] = 1;
                for (int k = 1; k < g && s + k < a.Count; k++) if (a[s + k] == null) { var c = (JsonObject)st.DeepClone(); c["a"] = 0; a[s + k] = c; }
                s += g - 1;
            }
    }
    void Glue()
    {
        var a = NoteSteps;
        for (int s = 0; s < a.Count; s++)
        {
            if (a[s] is not JsonObject st) continue;
            int end = s + (int)Doc.Num(st, "g", 1);
            while (end < a.Count && a[end] is JsonObject nx && Doc.Num(nx, "n", 0) == Doc.Num(st, "n", -1) && (nx["ch"]?.ToJsonString() ?? "") == (st["ch"]?.ToJsonString() ?? ""))
            {
                end += (int)Doc.Num(nx, "g", 1);
                a[end - (int)Doc.Num(nx, "g", 1)] = null;
            }
            st["g"] = end - s;
        }
    }
    void Legato()
    {
        var a = NoteSteps;
        int len = (int)Doc.Num(doc.Track(Ch), "len", a.Count);
        var on = Enumerable.Range(0, Math.Min(len, a.Count)).Where(s => a[s] is JsonObject).ToList();
        for (int i = 0; i < on.Count; i++)
        {
            int next = i + 1 < on.Count ? on[i + 1] : on[0] + len;
            ((JsonObject)a[on[i]]!)["g"] = Math.Max(1, Math.Min(16, next - on[i]));
        }
    }
    void Humanize()
    {
        var r = new Random();
        foreach (var st in NoteSteps.OfType<JsonObject>())
        {
            double baseV = Doc.Num(st, "a", 0) > 0 ? 1 : 0.7;
            if (st["pl"] is not JsonObject pl) st["pl"] = pl = new JsonObject();
            pl["vel"] = Math.Round(Math.Clamp(baseV + (r.NextDouble() - 0.5) * 0.25, 0.1, 1), 3);
        }
    }
    /// <summary>Frase casuale nella scala: ritmo dagli accenti del 4/4, salti piccoli, durata 1-3 step.</summary>
    void Riff()
    {
        var a = NoteSteps;
        var syn = doc.Pat["synth"];
        var iv = Scales.Of(Doc.Str(syn, "scale", "minor"));
        int root = doc.Base(Ch - 8);
        var r = new Random();
        bool mono = Doc.Mono(Ch - 8);
        int len = Math.Min(a.Count, (int)Doc.Num(doc.Track(Ch), "len", a.Count));
        for (int i = 0; i < a.Count; i++) a[i] = null;
        int deg = 0;
        for (int s = 0; s < len;)
        {
            double pOn = s % 4 == 0 ? 0.85 : s % 2 == 0 ? 0.5 : 0.3;
            if (r.NextDouble() > pOn) { s++; continue; }
            deg = Math.Clamp(deg + r.Next(-2, 3), -3, 9);
            int oct = (int)Math.Floor(deg / (double)iv.Length);
            int note = root + 12 * oct + iv[((deg % iv.Length) + iv.Length) % iv.Length];
            int g = mono ? r.Next(1, 3) : r.Next(2, 5);
            int di = ((deg % iv.Length) + iv.Length) % iv.Length;
            int third = ((iv[(di + 2) % iv.Length] - iv[di]) % 12 + 12) % 12;
            JsonNode? chord = mono ? null : new JsonArray(0, third, 7);
            a[s] = new JsonObject { ["n"] = note, ["g"] = g, ["a"] = s % 8 == 0 ? 1 : 0, ["sl"] = mono && r.NextDouble() < 0.12 ? 1 : 0, ["ch"] = chord };
            s += g;
        }
    }
}
