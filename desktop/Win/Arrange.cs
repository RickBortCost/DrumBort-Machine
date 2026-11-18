// Arrange.cs — Timeline dell'arrangiamento (Playlist di FL Studio / Tracks area di Logic).
//
// Ogni traccia ha una corsia; una regione è un pattern (P1…P8) che suona su quella traccia per
// una o più battute. Dati nel formato della web app: arr.bars[b].m[canale] = pattern (−1 = vuota).
//
//   clic nel vuoto        dipinge il pattern selezionato (lungo quanto il pattern), trascina per allungare
//   clic su una regione   seleziona (il pattern diventa quello in modifica); trascina per spostare
//   bordo destro          allunga / accorcia        Ctrl+trascina   copia
//   tasto destro          menu: pattern, duplica, rendi unico, elimina
//   doppio clic           apre il pattern negli step         righello   punto di partenza
//   Ctrl+rotella          zoom orizzontale                   Canc / Ctrl+D   elimina / duplica

using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace DrumBort.Win;

public sealed class Timeline : FrameworkElement
{
    public const double RulerH = 22, RowH = 48;
    readonly Doc doc;
    public double BW = 40;                       // larghezza di una battuta (zoom)
    public double Playhead = -1;                 // posizione in battute (−1 = ferma)
    public int Start;                            // battuta di partenza (righello)
    public event Action<int, int>? RegionPicked; // (canale, pattern)
    public event Action<int>? OpenPattern;       // doppio clic: pattern negli step
    public event Action? StartChanged;

    List<(int[] m, int s)> bars = new();
    List<int> tracks = new();
    (int ch, int b0, int b1)? sel;
    // Trascinamento
    enum Mode { None, Len, Move }
    Mode mode;
    int dCh, dB0, dB1, dSlot, grab;
    int oB0, oB1;
    bool copy, moved;

    public Timeline(Doc doc) { this.doc = doc; Focusable = true; FocusVisualStyle = null; ClipToBounds = true; }

    /// <summary>Ricarica tracce e battute dal progetto e ridimensiona.</summary>
    public void Reload(double minWidth)
    {
        tracks = doc.Tracks;
        if (mode == Mode.None) bars = doc.ArrBars;
        if (sel is var (c, b0, _) && (b0 >= bars.Count || !tracks.Contains(c) || bars[b0].m[c] < 0)) sel = null;
        Width = Math.Max(minWidth, NBars * BW);
        Height = RulerH + RowH * Math.Max(1, tracks.Count);
        InvalidateVisual();
    }
    int NBars => Math.Max(32, bars.Count + 16);
    public int Length => bars.Count;

    static Brush Alpha(Brush b, byte a) { var c = ((SolidColorBrush)b).Color; return new SolidColorBrush(Color.FromArgb(a, c.R, c.G, c.B)); }

    /// <summary>Regioni della traccia: battute consecutive con lo stesso pattern.</summary>
    List<(int b0, int b1, int slot)> Regions(int ch)
    {
        var o = new List<(int, int, int)>();
        for (int b = 0; b < bars.Count; b++)
        {
            int s = bars[b].m[ch];
            if (s < 0) continue;
            if (o.Count > 0 && o[^1].Item3 == s && o[^1].Item2 == b - 1) o[^1] = (o[^1].Item1, b, s);
            else o.Add((b, b, s));
        }
        return o;
    }

    // ------------------------------------------------------------------ disegno
    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, h = ActualHeight;
        dc.DrawRectangle(Theme.Bg, null, new Rect(0, 0, w, h));
        double dpi = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        var tf = new Typeface(Theme.Font, FontStyles.Normal, FontWeights.SemiBold, FontStretches.Normal);
        FormattedText T(string s, double size, Brush b) => new(s, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, tf, size, b, dpi);

        // Righello
        dc.DrawRectangle(Theme.Panel, null, new Rect(0, 0, w, RulerH));
        int step = BW < 22 ? 4 : BW < 34 ? 2 : 1;
        for (int b = 0; b < NBars; b++)
        {
            double x = b * BW;
            bool used = b < bars.Count;
            if (b == Start) dc.DrawRectangle(Theme.Orange, null, new Rect(x, 0, BW, 4));
            dc.DrawRectangle(used ? Theme.Panel3 : Theme.Panel2, null, new Rect(x, RulerH - 3, BW - 1, 3));
            if (b % step == 0) dc.DrawText(T((b + 1).ToString(CultureInfo.InvariantCulture), 10, b == Start ? Theme.Orange : Theme.Dim), new Point(x + 3, 4));
            dc.DrawRectangle(b % 4 == 0 ? Theme.Panel3 : Theme.Panel2, null, new Rect(x, RulerH, 1, h - RulerH));
        }
        if (bars.Count > 0) dc.DrawRectangle(Alpha(Theme.Orange, 70), null, new Rect(bars.Count * BW - 1, 0, 2, h));

        // Corsie e regioni
        for (int r = 0; r < tracks.Count; r++)
        {
            int ch = tracks[r];
            double y = RulerH + r * RowH;
            var col = Theme.Track(ch);
            dc.DrawRectangle(Theme.Panel3, null, new Rect(0, y + RowH - 1, w, 1));
            foreach (var (b0, b1, slot) in Regions(ch))
            {
                var rc = new Rect(b0 * BW + 1, y + 3, (b1 - b0 + 1) * BW - 2, RowH - 7);
                bool isSel = sel is var (sc, sb0, _) && sc == ch && sb0 == b0;
                dc.DrawRoundedRectangle(Alpha(col, 200), isSel ? new Pen(Brushes.White, 2) : new Pen(Alpha(col, 255), 1), rc, 3, 3);
                dc.DrawRectangle(Alpha(Theme.Dark, 70), null, new Rect(rc.X, rc.Y, rc.Width, 13));
                // Inizio di ogni ripetizione del pattern
                int pb = PatBars(slot);
                for (int b = b0 + pb; b <= b1; b += pb) dc.DrawRectangle(Alpha(Theme.Dark, 120), null, new Rect(b * BW, rc.Y + 13, 1, rc.Height - 13));
                dc.PushClip(new RectangleGeometry(rc));
                dc.DrawText(T($"P{slot + 1}", 10, Theme.Dark), new Point(rc.X + 4, rc.Y));
                Preview(dc, ch, slot, b0, b1, new Rect(rc.X, rc.Y + 14, rc.Width, rc.Height - 16));
                dc.Pop();
                // Maniglia per allungare
                dc.DrawRectangle(Alpha(Theme.Dark, 90), null, new Rect(rc.Right - 4, rc.Y + 14, 3, rc.Height - 18));
            }
        }
        if (tracks.Count == 0) dc.DrawText(T("Aggiungi una traccia (＋ TRACCIA) e dipingi i pattern sulla timeline.", 13, Theme.Dim), new Point(12, RulerH + 14));
        if (Playhead >= 0) dc.DrawRectangle(Theme.Orange, null, new Rect(Playhead * BW - 1, 0, 2, h));
    }

    int PatBars(int slot) => Doc.Num(doc.PatAt(slot), "bars", 1) is var b && (b == 2 || b == 4) ? (int)b : 1;

    /// <summary>Anteprima: colpi della batteria o note del synth ripetuti sulle battute della regione.</summary>
    void Preview(DrawingContext dc, int ch, int slot, int b0, int b1, Rect r)
    {
        var p = doc.PatAt(slot);
        int n = 16 * PatBars(slot), total = (b1 - b0 + 1) * 16;
        double sw = r.Width / total;
        var ink = Alpha(Theme.Dark, 170);
        if (!Doc.IsSynth(ch))
        {
            var row = p["steps"]?[ch] as JsonArray;
            if (row == null || row.Count == 0) return;
            int len = Math.Max(1, Math.Min(row.Count, (int)Doc.Num(Doc.TrackOf(p, ch), "len", n)));
            for (int s = 0; s < total; s++)
            {
                int v = (int)Doc.Val(row[((b0 * 16 + s) % n) % len]);
                if (v > 0) dc.DrawRectangle(ink, null, new Rect(r.X + s * sw + 0.5, r.Y + (v == 2 ? 0 : r.Height * 0.3), Math.Max(1, sw - 1), v == 2 ? r.Height : r.Height * 0.7));
            }
            return;
        }
        var steps = Doc.TrackOf(p, ch)["steps"] as JsonArray;
        if (steps == null || steps.Count == 0) return;
        var notes = steps.OfType<JsonObject>().SelectMany(st => Chord(st)).ToList();
        if (notes.Count == 0) return;
        int lo = notes.Min(), hi = Math.Max(notes.Max(), lo + 8);
        int slen = Math.Max(1, Math.Min(steps.Count, (int)Doc.Num(Doc.TrackOf(p, ch), "len", n)));
        for (int s = 0; s < total; s++)
        {
            if (steps[((b0 * 16 + s) % n) % slen] is not JsonObject st) continue;
            double g = Doc.Num(st, "g", 1);
            foreach (int nt in Chord(st))
                dc.DrawRectangle(ink, null, new Rect(r.X + s * sw, r.Bottom - 2 - (nt - lo) / (double)(hi - lo) * (r.Height - 3), Math.Max(2, g * sw - 1), 2));
        }
    }
    static IEnumerable<int> Chord(JsonObject st)
    {
        int n = (int)Doc.Num(st, "n", 60);
        if (st["ch"] is JsonArray c && c.Count > 0) return c.Select(x => n + (int)Doc.Val(x));
        return new[] { n };
    }

    // ------------------------------------------------------------------ modifica
    void Ensure(int n) { while (bars.Count < Math.Min(n, Doc.MaxArrBars)) bars.Add((Enumerable.Repeat(-1, 12).ToArray(), bars.Count > 0 ? bars[^1].s : doc.Slot)); }
    void SetCells(int ch, int b0, int b1, int slot)
    {
        Ensure(b1 + 1);
        for (int b = Math.Max(0, b0); b <= b1 && b < bars.Count; b++)
        {
            bars[b].m[ch] = slot;
            // Tempo e kit della battuta dal primo pattern che ci suona
            if (slot >= 0 && bars[b].m.Count(v => v >= 0) == 1) bars[b] = (bars[b].m, slot);
        }
    }
    void Trim() { while (bars.Count > 0 && bars[^1].m.All(v => v < 0)) bars.RemoveAt(bars.Count - 1); }
    List<(int[] m, int s)> Copy() => bars.Select(b => ((int[])b.m.Clone(), b.s)).ToList();

    /// <summary>Scrive le battute nel progetto (il progetto contiene ancora lo stato prima del gesto: annullabile).</summary>
    void Save()
    {
        Trim();
        doc.Snapshot();
        doc.ArrBars = Copy();
        doc.Commit("arr", "mode");
    }

    int RowAt(double y) => y < RulerH ? -1 : (int)((y - RulerH) / RowH);
    int BarAt(double x) => Math.Clamp((int)(x / BW), 0, Doc.MaxArrBars - 1);
    (int b0, int b1, int slot)? RegionAt(int ch, int b) => Regions(ch).Cast<(int b0, int b1, int slot)?>().FirstOrDefault(r => r!.Value.b0 <= b && b <= r.Value.b1);

    protected override void OnMouseDown(MouseButtonEventArgs e)
    {
        Focus();
        var p = e.GetPosition(this);
        int b = BarAt(p.X), row = RowAt(p.Y);
        if (row < 0)
        {
            Start = b; StartChanged?.Invoke(); InvalidateVisual();
            e.Handled = true; return;
        }
        if (row >= tracks.Count) { sel = null; InvalidateVisual(); return; }
        int ch = tracks[row];
        var reg = RegionAt(ch, b);
        if (e.ChangedButton == MouseButton.Right)
        {
            if (reg is var (rb0, rb1, rs)) { sel = (ch, rb0, rb1); InvalidateVisual(); RegionMenu(ch, rb0, rb1, rs); }
            e.Handled = true; return;
        }
        if (e.ChangedButton != MouseButton.Left) return;
        if (reg is var (b0, b1, slot))
        {
            sel = (ch, b0, b1);
            RegionPicked?.Invoke(ch, slot);
            if (e.ClickCount == 2) { OpenPattern?.Invoke(slot); e.Handled = true; return; }
            bool edge = p.X > (b1 + 1) * BW - Math.Min(10, BW / 3);
            copy = !edge && Keyboard.Modifiers.HasFlag(ModifierKeys.Control);
            (mode, dCh, dB0, dB1, dSlot, grab, moved) = (edge ? Mode.Len : Mode.Move, ch, b0, b1, slot, b, false);
            (oB0, oB1) = (b0, b1);
        }
        else
        {
            int slot0 = doc.Slot, len = PatBars(slot0);
            RegionPicked?.Invoke(ch, slot0);
            SetCells(ch, b, b + len - 1, slot0);
            sel = (ch, b, b + len - 1);
            (mode, dCh, dB0, dB1, dSlot, grab, moved) = (Mode.Len, ch, b, b + len - 1, slot0, b, true);
        }
        CaptureMouse();
        InvalidateVisual();
        e.Handled = true;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        var p = e.GetPosition(this);
        if (mode == Mode.None)
        {
            int row = RowAt(p.Y), b = BarAt(p.X);
            Cursor = row >= 0 && row < tracks.Count && RegionAt(tracks[row], b) is var (_, b1, _) && p.X > (b1 + 1) * BW - Math.Min(10, BW / 3) ? Cursors.SizeWE : Cursors.Arrow;
            return;
        }
        int bb = BarAt(p.X);
        if (mode == Mode.Len)
        {
            int end = Math.Max(dB0, bb);
            if (end == dB1) return;
            if (end < dB1) SetCells(dCh, end + 1, dB1, -1); else SetCells(dCh, dB1 + 1, end, dSlot);
            dB1 = end; moved = true;
        }
        else
        {
            int d = bb - grab;
            if (d == 0) return;
            int len = dB1 - dB0, nb0 = Math.Max(0, dB0 + d);
            SetCells(dCh, dB0, dB1, -1);
            if (copy) SetCells(dCh, oB0, oB1, dSlot);      // Ctrl: l'originale resta
            SetCells(dCh, nb0, nb0 + len, dSlot);
            dB0 = nb0; dB1 = nb0 + len; grab = bb; moved = true;
        }
        sel = (dCh, dB0, dB1);
        Width = Math.Max(Width, NBars * BW);
        InvalidateVisual();
    }

    protected override void OnMouseUp(MouseButtonEventArgs e)
    {
        if (mode == Mode.None) return;
        mode = Mode.None;
        ReleaseMouseCapture();
        if (moved) Save();
    }

    protected override void OnMouseWheel(MouseWheelEventArgs e)
    {
        if (!Keyboard.Modifiers.HasFlag(ModifierKeys.Control)) return;
        BW = Math.Clamp(BW * (e.Delta > 0 ? 1.2 : 1 / 1.2), 14, 160);
        Width = Math.Max(((FrameworkElement)Parent)?.ActualWidth ?? 0, NBars * BW);
        InvalidateVisual();
        e.Handled = true;
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (sel is not var (ch, b0, b1)) return;
        if (e.Key is Key.Delete or Key.Back) { Delete(ch, b0, b1); e.Handled = true; }
        else if (e.Key == Key.D && Keyboard.Modifiers == ModifierKeys.Control) { Duplicate(ch, b0, b1); e.Handled = true; }
    }

    void Delete(int ch, int b0, int b1) { SetCells(ch, b0, b1, -1); sel = null; Save(); }
    void Duplicate(int ch, int b0, int b1)
    {
        int slot = bars[b0].m[ch], len = b1 - b0 + 1;
        // Subito dopo la regione; se il pattern è lo stesso, separata da una battuta vuota non serve: le regioni si uniscono
        SetCells(ch, b1 + 1, b1 + len, slot);
        sel = (ch, b0, b1 + len);
        Save();
    }

    void RegionMenu(int ch, int b0, int b1, int slot)
    {
        var items = new List<(string, Action?)>();
        for (int s = 0; s < Doc.Slots; s++)
        {
            int ss = s;
            if (s != slot) items.Add(($"Usa il pattern P{s + 1}", () => { SetCells(ch, b0, b1, ss); Save(); RegionPicked?.Invoke(ch, ss); }));
        }
        items.Add(("Rendi unico (copia in un pattern libero)", () => MakeUnique(ch, b0, b1, slot)));
        items.Add(("Apri negli step", () => OpenPattern?.Invoke(slot)));
        items.Add(("Duplica  (Ctrl+D)", () => Duplicate(ch, b0, b1)));
        items.Add(("Elimina  (Canc)", () => Delete(ch, b0, b1)));
        Menu.Show(this, items);
    }

    /// <summary>Copia il pattern in uno slot non usato dall'arrangiamento e lo assegna alla regione (FL "Make unique").</summary>
    void MakeUnique(int ch, int b0, int b1, int slot)
    {
        var used = bars.SelectMany(b => b.m).Where(v => v >= 0).ToHashSet();
        int free = Enumerable.Range(0, Doc.Slots).FirstOrDefault(s => !used.Contains(s) && s != slot, -1);
        if (free < 0) { MessageBox.Show(Window.GetWindow(this), "Tutti gli 8 pattern sono usati nell'arrangiamento.", "DrumBort"); return; }
        doc.Snapshot();
        doc.Root["slots"]![free] = doc.PatAt(slot).DeepClone();
        var b = Copy();
        for (int i = b0; i <= b1; i++) b[i].m[ch] = free;
        doc.ArrBars = b;
        doc.Commit("arr", "mode", $"p{free}");
        RegionPicked?.Invoke(ch, free);
    }
}
