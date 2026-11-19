// Grids.cs — Editor delle note: riga di step (batteria e synth) e piano roll delle tracce synth.

using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace DrumBort.Win;

/// <summary>
/// Riga di step di una traccia. Batteria: clic accende/spegne (Shift o tasto destro = accento),
/// trascinando si dipinge. Synth: clic aggiunge la tonica o toglie la nota (il piano roll in basso
/// modifica altezze e durate).
/// </summary>
public sealed class StepRow : FrameworkElement
{
    readonly Doc doc;
    public readonly int Ch;
    public int Playhead = -1;
    int paint = -1, lastCell = -1;
    bool painting;
    public StepRow(Doc doc, int ch) { this.doc = doc; Ch = ch; Height = 40; Cursor = Cursors.Hand; }

    int N => doc.StepCount;
    double CellW => ActualWidth / N;
    bool Synth => Doc.IsSynth(Ch);
    JsonArray Drum => (JsonArray)doc.Pat["steps"]![Ch]!;
    JsonArray Syn => (JsonArray)Doc.TrackOf(doc.Pat, Ch)["steps"]!;
    int Len => (int)Doc.Num(Doc.TrackOf(doc.Pat, Ch), "len", N);

    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, h = ActualHeight, cw = CellW;
        var col = Theme.Track(Ch);
        dc.DrawRectangle(Theme.Bg, null, new Rect(0, 0, w, h));
        // Note synth: durate (gate) dietro le celle
        var cover = new bool[N];
        if (Synth)
            for (int s = 0; s < N; s++)
                if (Syn.Count > s && Syn[s] is JsonObject st)
                    for (int g = 1; g < Doc.Num(st, "g", 1) && s + g < N; g++) cover[s + g] = true;
        for (int s = 0; s < N; s++)
        {
            var r = new Rect(s * cw + 1, 3, Math.Max(1, cw - 2), h - 6);
            bool grp = (s / 4) % 2 == 1;
            Brush bg = grp ? Theme.Panel2 : Theme.Panel3;
            int v = 0;
            if (Synth) v = Syn.Count > s && Syn[s] is JsonObject so ? (Doc.Num(so, "a", 0) > 0 ? 2 : 1) : 0;
            else v = Drum.Count > s ? (int)Doc.Val(Drum[s]) : 0;
            dc.DrawRoundedRectangle(bg, null, r, 2, 2);
            if (cover[s]) dc.DrawRoundedRectangle(new SolidColorBrush(Color.FromArgb(90, ((SolidColorBrush)col).Color.R, ((SolidColorBrush)col).Color.G, ((SolidColorBrush)col).Color.B)), null, r, 2, 2);
            if (v > 0) dc.DrawRoundedRectangle(v == 2 ? Brushes.White : col, null, r, 2, 2);
            if (v == 2) dc.DrawRoundedRectangle(col, null, new Rect(r.X + 3, r.Y + 3, Math.Max(1, r.Width - 6), r.Height - 6), 2, 2);
            if (s >= Len) dc.DrawRectangle(new SolidColorBrush(Color.FromArgb(150, 18, 23, 27)), null, r);
            if (s == Playhead) dc.DrawRoundedRectangle(null, new Pen(Theme.Orange, 2), r, 2, 2);
        }
        // Nome della nota sugli step synth
        if (Synth && cw >= 22)
            for (int s = 0; s < N; s++)
                if (Syn.Count > s && Syn[s] is JsonObject st)
                {
                    var t = new FormattedText(NoteName((int)Doc.Num(st, "n", 60)), CultureInfo.InvariantCulture, FlowDirection.LeftToRight,
                        new Typeface(Theme.Font, FontStyles.Normal, FontWeights.SemiBold, FontStretches.Normal), 9, Theme.Dark, VisualTreeHelper.GetDpi(this).PixelsPerDip);
                    dc.DrawText(t, new Point(s * cw + 3, h - 15));
                }
    }

    public static string NoteName(int n) => new[] { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" }[((n % 12) + 12) % 12] + (n / 12 - 1);

    int CellAt(Point p) => Math.Clamp((int)(p.X / Math.Max(1, CellW)), 0, N - 1);

    protected override void OnMouseDown(MouseButtonEventArgs e)
    {
        int s = CellAt(e.GetPosition(this));
        doc.Snapshot();
        bool accent = e.ChangedButton == MouseButton.Right || Keyboard.Modifiers.HasFlag(ModifierKeys.Shift);
        if (Synth)
        {
            var arr = Syn;
            int k = Ch - 8;
            if (arr[s] is JsonObject st)
            {
                if (accent) st["a"] = Doc.Num(st, "a", 0) > 0 ? 0 : 1;
                else arr[s] = null;
            }
            else
            {
                int n = doc.Base(k);
                arr[s] = new JsonObject { ["n"] = n, ["g"] = 1, ["a"] = accent ? 1 : 0, ["sl"] = 0, ["ch"] = Doc.Mono(k) ? null : new JsonArray(0, 3, 7) };
                doc.PreviewSynth(k, n);
            }
            Done();
            e.Handled = true;
            return;
        }
        int cur = (int)Doc.Val(Drum[s]);
        paint = accent ? (cur == 2 ? 1 : 2) : (cur > 0 ? 0 : 1);
        Drum[s] = paint;
        ClearOpt(s);
        if (paint > 0) doc.PreviewDrum(Ch);
        painting = true; lastCell = s;
        CaptureMouse();
        InvalidateVisual();
        doc.CommitQuiet(doc.PatKey);
        e.Handled = true;
    }
    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (!painting) return;
        int s = CellAt(e.GetPosition(this));
        if (s == lastCell) return;
        lastCell = s;
        Drum[s] = paint;
        ClearOpt(s);
        InvalidateVisual();
        doc.CommitQuiet(doc.PatKey);
    }
    protected override void OnMouseUp(MouseButtonEventArgs e)
    {
        if (!painting) return;
        painting = false;
        ReleaseMouseCapture();
        Done();
    }
    void ClearOpt(int s) { if (paint == 0 && doc.Pat["opts"]?[Ch] is JsonArray o && o.Count > s) o[s] = null; }
    void Done() => doc.Commit(doc.PatKey);
}

/// <summary>
/// Piano roll di una traccia synth: clic su una cella vuota crea una nota (trascinando a destra si
/// allunga), clic su una nota la toglie, Shift+clic cambia l'accento. PAD e KEYS: più note sullo
/// stesso step formano un accordo; BASS e LEAD: una nota per step. Alt+clic: slide. Righe della
/// scala evidenziate. Mostra solo le note della traccia selezionata.
/// </summary>
public sealed class PianoRoll : FrameworkElement
{
    readonly Doc doc;
    public int Ch;
    public int Playhead = -1;
    const double Key = 46, RowH = 14;
    const int Span = 37;          // da una ottava sotto la tonica a due sopra
    (int s, int p)? drawing;

    public PianoRoll(Doc doc, int ch) { this.doc = doc; Ch = ch; Height = Span * RowH; Cursor = Cursors.Cross; }

    int K => Ch - 8;
    /// <summary>Y del centro delle note (o della tonica) per centrare lo scorrimento.</summary>
    public double FocusY()
    {
        var ps = Steps.OfType<JsonObject>().SelectMany(Pitches).ToList();
        double p = ps.Count > 0 ? ps.Average() : doc.Base(K);
        return (Low + Span - 1 - p) * RowH;
    }
    int Low => doc.Base(K) - 12;
    int N => doc.StepCount;
    double CellW => (ActualWidth - Key) / N;
    JsonArray Steps => (JsonArray)Doc.TrackOf(doc.Pat, Ch)["steps"]!;
    static int[] Pitches(JsonObject st)
    {
        int n = (int)Doc.Num(st, "n", 60);
        return st["ch"] is JsonArray ch && ch.Count > 0 ? ch.Select(c => n + (int)Doc.Val(c)).ToArray() : new[] { n };
    }

    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, cw = CellW;
        var col = Theme.Track(Ch);
        int low = Low, root = doc.Base(K) % 12;
        var dpi = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        for (int r = 0; r < Span; r++)
        {
            int p = low + Span - 1 - r;
            double y = r * RowH;
            bool black = new[] { 1, 3, 6, 8, 10 }.Contains(p % 12);
            // Righe della scala del pattern più chiare (come lo "scale highlighting" di FL Studio)
            bool inScale = Scales.In(doc, p);
            dc.DrawRectangle(inScale ? (black ? Theme.Panel : Theme.Panel2) : Theme.Bg, null, new Rect(Key, y, w - Key, RowH));
            dc.DrawLine(new Pen(Theme.Dark, 0.5), new Point(Key, y), new Point(w, y));
            dc.DrawRectangle(black ? Brushes.Black : Brushes.WhiteSmoke, new Pen(Theme.Dark, 0.5), new Rect(0, y, Key - 2, RowH));
            if (p % 12 == root || p % 12 == 0)
            {
                var t = new FormattedText(StepRow.NoteName(p), CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface(Theme.Font, FontStyles.Normal, FontWeights.Normal, FontStretches.Normal), 9,
                    p % 12 == root ? Theme.Orange : Brushes.Gray, dpi);
                dc.DrawText(t, new Point(Key - t.Width - 4, y + 1));
            }
        }
        for (int s = 0; s <= N; s++)
            dc.DrawLine(new Pen(s % 4 == 0 ? Theme.Edge : Theme.Panel3, s % 16 == 0 ? 1.5 : 0.6), new Point(Key + s * cw, 0), new Point(Key + s * cw, ActualHeight));
        if (Playhead >= 0) dc.DrawRectangle(new SolidColorBrush(Color.FromArgb(40, 255, 155, 61)), null, new Rect(Key + Playhead * cw, 0, cw, ActualHeight));
        var steps = Steps;
        for (int s = 0; s < N && s < steps.Count; s++)
        {
            if (steps[s] is not JsonObject st) continue;
            double g = Doc.Num(st, "g", 1);
            bool acc = Doc.Num(st, "a", 0) > 0;
            foreach (int p in Pitches(st))
            {
                int r = low + Span - 1 - p;
                if (r < 0 || r >= Span) continue;
                var rect = new Rect(Key + s * cw + 1, r * RowH + 1, Math.Max(3, g * cw - 2), RowH - 2);
                dc.DrawRoundedRectangle(col, new Pen(acc ? Brushes.White : Theme.Dark, acc ? 1.5 : 1), rect, 2, 2);
                // Slide (portamento verso la nota successiva)
                if (Doc.Num(st, "sl", 0) > 0) dc.DrawLine(new Pen(Brushes.White, 1.5), new Point(rect.Right - 6, rect.Bottom - 2), new Point(rect.Right, rect.Top + 2));
            }
        }
    }

    (int s, int p) At(Point pt)
    {
        int s = Math.Clamp((int)((pt.X - Key) / Math.Max(1, CellW)), 0, N - 1);
        int r = Math.Clamp((int)(pt.Y / RowH), 0, Span - 1);
        return (s, Low + Span - 1 - r);
    }
    /// <summary>Step che contiene una nota di altezza p sotto lo step s (anche la sua coda).</summary>
    int NoteAt(int s, int p)
    {
        var steps = Steps;
        for (int i = s; i >= 0; i--)
            if (i < steps.Count && steps[i] is JsonObject st && Pitches(st).Contains(p) && i + Doc.Num(st, "g", 1) > s) return i;
        return -1;
    }

    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        if (e.GetPosition(this).X < Key)
        {
            var (_, kp) = At(e.GetPosition(this));
            doc.Op("prev", new JsonObject { ["k"] = K, ["notes"] = new JsonArray(kp) });
            return;
        }
        var (s, p) = At(e.GetPosition(this));
        doc.Snapshot();
        var steps = Steps;
        int at = NoteAt(s, p);
        if (at >= 0)
        {
            var st = (JsonObject)steps[at]!;
            if (Keyboard.Modifiers.HasFlag(ModifierKeys.Shift)) st["a"] = Doc.Num(st, "a", 0) > 0 ? 0 : 1;
            else if (Keyboard.Modifiers.HasFlag(ModifierKeys.Alt)) st["sl"] = Doc.Num(st, "sl", 0) > 0 ? 0 : 1;
            else RemovePitch(at, p);
            doc.Commit(doc.PatKey);
            e.Handled = true;
            return;
        }
        if (Doc.Mono(K) || steps[s] is not JsonObject cur)
            steps[s] = new JsonObject { ["n"] = p, ["g"] = 1, ["a"] = 0, ["sl"] = 0, ["ch"] = null };
        else
        {
            var ps = Pitches(cur).Append(p).Distinct().OrderBy(x => x).ToArray();
            cur["n"] = ps[0];
            cur["ch"] = new JsonArray(ps.Select(x => (JsonNode)(x - ps[0])).ToArray());
        }
        doc.Op("prev", new JsonObject { ["k"] = K, ["notes"] = new JsonArray(p) });
        drawing = (s, p);
        CaptureMouse();
        doc.CommitQuiet(doc.PatKey);
        InvalidateVisual();
        e.Handled = true;
    }
    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (drawing is not var (s0, _) || Steps[s0] is not JsonObject st) return;
        var (s, _) = At(e.GetPosition(this));
        int g = Math.Max(1, s - s0 + 1);
        if (g == (int)Doc.Num(st, "g", 1)) return;
        st["g"] = g;
        InvalidateVisual();
    }
    protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e)
    {
        if (drawing == null) return;
        drawing = null;
        ReleaseMouseCapture();
        doc.Commit(doc.PatKey);
    }
    protected override void OnMouseRightButtonDown(MouseButtonEventArgs e)
    {
        var (s, p) = At(e.GetPosition(this));
        int at = NoteAt(s, p);
        if (at < 0) return;
        doc.Snapshot();
        RemovePitch(at, p);
        doc.Commit(doc.PatKey);
        e.Handled = true;
    }
    void RemovePitch(int at, int p)
    {
        var steps = Steps;
        var st = (JsonObject)steps[at]!;
        var rest = Pitches(st).Where(x => x != p).OrderBy(x => x).ToArray();
        if (rest.Length == 0) { steps[at] = null; return; }
        st["n"] = rest[0];
        st["ch"] = rest.Length > 1 ? new JsonArray(rest.Select(x => (JsonNode)(x - rest[0])).ToArray()) : null;
    }
}
