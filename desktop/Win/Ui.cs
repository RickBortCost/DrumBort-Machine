// Ui.cs — Tema e controlli di base dell'interfaccia Windows, disegnati in codice
// (pulsanti, interruttori, menu a tendina, cursori, manopole, misuratori).

using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;

namespace DrumBort.Win;

/// <summary>Colori del tema (ardesia con accenti arancio, come la web app).</summary>
public static class Theme
{
    static SolidColorBrush B(uint argb) { var b = new SolidColorBrush(Color.FromArgb((byte)(argb >> 24), (byte)(argb >> 16), (byte)(argb >> 8), (byte)argb)); b.Freeze(); return b; }
    public static readonly SolidColorBrush Bg = B(0xFF1D2328), Panel = B(0xFF2A3137), Panel2 = B(0xFF323A41), Panel3 = B(0xFF3A434B),
        Edge = B(0xFF46505A), Ink = B(0xFFE6E8EA), Dim = B(0xFF97A1AA), Lcd = B(0xFFB8F27A), Orange = B(0xFFFF9B3D),
        Green = B(0xFF6FD08C), Red = B(0xFFE5432F), Cyan = B(0xFF5FD3E6), Dark = B(0xFF12171B), Hover = B(0xFF46505A),
        OnBg = B(0xFF5A4A35), SoloBg = B(0xFF2F4A5A);
    public static readonly string[] TrackColors = { "#e5432f", "#f08a24", "#f2c230", "#d9d2bd", "#a8c7c0", "#6aa9d8", "#9b8ad6", "#d47bb0", "#f08a24", "#5fd3e6", "#a98be0", "#6fd08c" };
    public static SolidColorBrush Track(int i)
    {
        var c = (Color)ColorConverter.ConvertFromString(TrackColors[Math.Clamp(i, 0, 11)]);
        var b = new SolidColorBrush(c); b.Freeze(); return b;
    }
    public static readonly FontFamily Font = new("Segoe UI");
    public static readonly FontFamily Mono = new("Consolas");
}

/// <summary>Testo con lo stile del tema.</summary>
public static class Txt
{
    public static TextBlock Make(string s, double size = 12, Brush? fg = null, bool bold = false) => new()
    {
        Text = s, FontSize = size, Foreground = fg ?? Theme.Ink, FontFamily = Theme.Font,
        FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal, VerticalAlignment = VerticalAlignment.Center,
        TextTrimming = TextTrimming.CharacterEllipsis,
    };
}

/// <summary>Pulsante (anche interruttore con IsOn) disegnato con un Border.</summary>
public class Btn : Border
{
    readonly TextBlock label;
    bool on, hover, down;
    public event Action? Click;
    public Brush OnBrush = Theme.OnBg, OnBorder = Theme.Orange;
    public Btn(string text, double minWidth = 0, string? tip = null)
    {
        label = Txt.Make(text, 12);
        label.HorizontalAlignment = HorizontalAlignment.Center;
        label.TextTrimming = TextTrimming.None;
        Child = label;
        MinWidth = minWidth; MinHeight = 26;
        Padding = new Thickness(9, 2, 9, 2);
        Margin = new Thickness(2);
        CornerRadius = new CornerRadius(3);
        BorderThickness = new Thickness(1);
        Cursor = Cursors.Hand;
        Focusable = true;
        if (tip != null) ToolTip = tip;
        Paint();
        MouseEnter += (_, _) => { hover = true; Paint(); };
        MouseLeave += (_, _) => { hover = false; down = false; Paint(); };
        MouseLeftButtonDown += (_, e) => { down = true; Paint(); e.Handled = true; };
        MouseLeftButtonUp += (_, e) => { if (down) { down = false; Paint(); Click?.Invoke(); } e.Handled = true; };
        KeyDown += (_, e) => { if (e.Key is Key.Enter or Key.Space) { Click?.Invoke(); e.Handled = true; } };
    }
    public string Text { get => label.Text; set => label.Text = value; }
    public Brush Fg { set => label.Foreground = value; }
    public bool IsOn { get => on; set { on = value; Paint(); } }
    public bool Enabled { get => IsEnabled; set { IsEnabled = value; Opacity = value ? 1 : 0.4; } }
    void Paint()
    {
        Background = on ? OnBrush : down ? Theme.Panel : hover ? Theme.Hover : Theme.Panel3;
        BorderBrush = on ? OnBorder : Theme.Edge;
    }
}

/// <summary>Menu a tendina: un pulsante che apre un menu con le voci.</summary>
public sealed class Dropdown : Btn
{
    readonly List<(string value, string label)> items = new();
    string value = "";
    public event Action<string>? Changed;
    public Dropdown(double minWidth = 90) : base("", minWidth)
    {
        Click += Open;
    }
    public void SetItems(IEnumerable<(string value, string label)> list)
    {
        items.Clear(); items.AddRange(list);
        Value = value;
    }
    public string Value
    {
        get => value;
        set { this.value = value; var it = items.FirstOrDefault(x => x.value == value); Text = (it.label ?? value) + "  ▾"; }
    }
    void Open()
    {
        var m = new ContextMenu { PlacementTarget = this, Placement = PlacementMode.Bottom, Background = Theme.Panel2, Foreground = Theme.Ink, MaxHeight = 560 };
        string? group = null;
        foreach (var (v, l) in items)
        {
            if (v.StartsWith("#"))
            {
                group = l;
                m.Items.Add(new MenuItem { Header = l, IsEnabled = false, Foreground = Theme.Dim, FontSize = 10 });
                continue;
            }
            var mi = new MenuItem { Header = l, IsCheckable = true, IsChecked = v == value, Foreground = Theme.Ink, Background = Theme.Panel2 };
            string vv = v;
            mi.Click += (_, _) => { Value = vv; Changed?.Invoke(vv); };
            m.Items.Add(mi);
        }
        m.IsOpen = true;
    }
}

/// <summary>Menu contestuale con le voci (testo, azione, abilitata).</summary>
public static class Menu
{
    public static void Show(FrameworkElement target, IEnumerable<(string label, Action? act)> items)
    {
        var m = new ContextMenu { PlacementTarget = target, Placement = PlacementMode.Bottom, Background = Theme.Panel2, Foreground = Theme.Ink };
        foreach (var (l, a) in items)
        {
            if (a == null) { m.Items.Add(new MenuItem { Header = l, IsEnabled = l.Length > 0 && !l.StartsWith("—"), Foreground = Theme.Dim, FontSize = 10 }); continue; }
            var mi = new MenuItem { Header = l, Foreground = Theme.Ink, Background = Theme.Panel2 };
            var act = a;
            mi.Click += (_, _) => act();
            m.Items.Add(mi);
        }
        m.IsOpen = true;
    }
}

/// <summary>Cursore orizzontale sottile (volume, pan, swing). Doppio clic: valore iniziale.</summary>
public sealed class HSlider : FrameworkElement
{
    public double Min, Max, Def, Value;
    public Brush Color = Theme.Orange;
    public bool Bipolar;
    public event Action<double>? Changed;
    public event Action? Begin, End;
    bool drag;
    public HSlider(double min, double max, double def, double value)
    {
        Min = min; Max = max; Def = def; Value = value;
        Height = 16; MinWidth = 40; Cursor = Cursors.SizeWE; Focusable = true;
        Bipolar = min < 0 && max > 0;
    }
    double F => (Value - Min) / (Max - Min);
    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, h = ActualHeight, y = h / 2;
        dc.DrawRectangle(Brushes.Transparent, null, new Rect(0, 0, w, h));
        dc.DrawRoundedRectangle(Theme.Dark, null, new Rect(0, y - 2, w, 4), 2, 2);
        double x0 = Bipolar ? (0 - Min) / (Max - Min) * w : 0, x1 = F * w;
        dc.DrawRectangle(Color, null, new Rect(Math.Min(x0, x1), y - 2, Math.Abs(x1 - x0), 4));
        dc.DrawRoundedRectangle(Color, new Pen(Theme.Dark, 1), new Rect(Math.Clamp(x1 - 4, 0, w - 8), 1, 8, h - 2), 2, 2);
    }
    void SetFrom(double x)
    {
        double v = Min + Math.Clamp(x / Math.Max(1, ActualWidth), 0, 1) * (Max - Min);
        Value = Math.Round(v, 3);
        InvalidateVisual();
        Changed?.Invoke(Value);
    }
    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2) { Value = Def; InvalidateVisual(); Changed?.Invoke(Value); End?.Invoke(); e.Handled = true; return; }
        Begin?.Invoke();
        drag = true; CaptureMouse(); Focus();
        SetFrom(e.GetPosition(this).X);
        e.Handled = true;
    }
    protected override void OnMouseMove(MouseEventArgs e) { if (drag) SetFrom(e.GetPosition(this).X); }
    protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e) { if (drag) { drag = false; ReleaseMouseCapture(); End?.Invoke(); } }
    protected override void OnMouseWheel(MouseWheelEventArgs e)
    {
        Begin?.Invoke();
        Value = Math.Clamp(Value + Math.Sign(e.Delta) * (Max - Min) / 50, Min, Max);
        InvalidateVisual(); Changed?.Invoke(Value); End?.Invoke();
        e.Handled = true;
    }
    public void Set(double v) { Value = v; InvalidateVisual(); }
}

/// <summary>
/// Manopola rotativa: trascina in verticale (Shift = fine), rotella, frecce, doppio clic = valore
/// iniziale. Scala lineare o logaritmica; arco dal centro per i parametri bipolari.
/// </summary>
public sealed class Knob : FrameworkElement
{
    public readonly string Label;
    public double Min, Max, Def, Value;
    public bool Log, Integer;
    public Func<double, string> Format;
    public Brush Color = Theme.Orange;
    public event Action<double>? Changed;
    public event Action? Begin, End;
    double dragY, dragF; bool drag;

    public Knob(string label, double min, double max, double def, double value, Func<double, string> fmt, bool log = false)
    {
        Label = label; Min = min; Max = max; Def = def; Value = value; Format = fmt; Log = log;
        Width = 62; Height = 74; Cursor = Cursors.SizeNS; Focusable = true;
        ToolTip = $"{label}: trascina in verticale (Shift = fine), doppio clic = valore iniziale";
    }
    double Norm(double v) => Log ? Math.Log(v / Min) / Math.Log(Max / Min) : (v - Min) / (Max - Min);
    double Denorm(double f) => Log ? Min * Math.Pow(Max / Min, f) : Min + f * (Max - Min);
    double Round(double v)
    {
        if (Integer) return Math.Round(v);
        if (Log) { double m = Math.Pow(10, Math.Floor(Math.Log10(Math.Abs(v))) - 2); return Math.Round(v / m) * m; }
        double r = Max - Min, st = r >= 20 ? 0.1 : 0.01;
        return Math.Round(Math.Round(v / st) * st, 3);
    }
    void Set(double v, bool notify = true)
    {
        Value = Math.Clamp(Round(v), Min, Max);
        InvalidateVisual();
        if (notify) Changed?.Invoke(Value);
    }
    public void Update(double v) => Set(v, false);

    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, cx = w / 2, cy = 34, r = 16;
        dc.DrawRectangle(Brushes.Transparent, null, new Rect(0, 0, w, ActualHeight));
        var lab = Fmt(Label, 9.5, Theme.Dim);
        dc.DrawText(lab, new Point(cx - lab.Width / 2, 2));
        // Arco di fondo e arco del valore (−135°…+135°)
        double f = Math.Clamp(Norm(Value), 0, 1), f0 = !Log && Min < 0 && Max > 0 ? Norm(0) : 0;
        DrawArc(dc, cx, cy, r + 3, 0, 1, Theme.Dark, 4);
        DrawArc(dc, cx, cy, r + 3, Math.Min(f0, f), Math.Max(f0, f), Color, 4);
        dc.DrawEllipse(new RadialGradientBrush(System.Windows.Media.Color.FromRgb(0x4a, 0x54, 0x5d), System.Windows.Media.Color.FromRgb(0x26, 0x2c, 0x31)), new Pen(Theme.Dark, 1), new Point(cx, cy), r, r);
        double a = (-135 + f * 270) * Math.PI / 180;
        dc.DrawLine(new Pen(Brushes.WhiteSmoke, 2) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round },
            new Point(cx + Math.Sin(a) * 4, cy - Math.Cos(a) * 4), new Point(cx + Math.Sin(a) * (r - 3), cy - Math.Cos(a) * (r - 3)));
        var val = Fmt(Format(Value), 10.5, Theme.Lcd);
        dc.DrawText(val, new Point(cx - val.Width / 2, cy + r + 5));
        if (IsKeyboardFocused) dc.DrawEllipse(null, new Pen(Color, 1), new Point(cx, cy), r + 6, r + 6);
    }
    static void DrawArc(DrawingContext dc, double cx, double cy, double r, double f0, double f1, Brush b, double th)
    {
        if (f1 - f0 < 0.002) return;
        double a0 = (-135 + f0 * 270) * Math.PI / 180, a1 = (-135 + f1 * 270) * Math.PI / 180;
        var p0 = new Point(cx + Math.Sin(a0) * r, cy - Math.Cos(a0) * r);
        var p1 = new Point(cx + Math.Sin(a1) * r, cy - Math.Cos(a1) * r);
        var g = new StreamGeometry();
        using (var c = g.Open())
        {
            c.BeginFigure(p0, false, false);
            c.ArcTo(p1, new Size(r, r), 0, (f1 - f0) * 270 > 180, SweepDirection.Clockwise, true, false);
        }
        g.Freeze();
        dc.DrawGeometry(null, new Pen(b, th) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round }, g);
    }
    FormattedText Fmt(string s, double size, Brush b) =>
        new(s, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface(Theme.Font, FontStyles.Normal, FontWeights.Normal, FontStretches.Normal), size, b, VisualTreeHelper.GetDpi(this).PixelsPerDip);

    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2) { Begin?.Invoke(); Set(Def); End?.Invoke(); e.Handled = true; return; }
        Begin?.Invoke();
        drag = true; dragY = e.GetPosition(this).Y; dragF = Math.Clamp(Norm(Value), 0, 1);
        CaptureMouse(); Focus(); e.Handled = true;
    }
    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (!drag) return;
        double px = Keyboard.Modifiers.HasFlag(ModifierKeys.Shift) ? 600 : 160;
        Set(Denorm(Math.Clamp(dragF + (dragY - e.GetPosition(this).Y) / px, 0, 1)));
    }
    protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e) { if (drag) { drag = false; ReleaseMouseCapture(); End?.Invoke(); } }
    protected override void OnMouseWheel(MouseWheelEventArgs e)
    {
        Begin?.Invoke();
        Set(Denorm(Math.Clamp(Norm(Value) + Math.Sign(e.Delta) / 50.0, 0, 1)));
        End?.Invoke();
        e.Handled = true;
    }
    protected override void OnKeyDown(KeyEventArgs e)
    {
        int dir = e.Key is Key.Up or Key.Right ? 1 : e.Key is Key.Down or Key.Left ? -1 : 0;
        if (dir == 0) return;
        Begin?.Invoke();
        Set(Denorm(Math.Clamp(Norm(Value) + dir / (Keyboard.Modifiers.HasFlag(ModifierKeys.Shift) ? 200.0 : 50.0), 0, 1)));
        End?.Invoke();
        e.Handled = true;
    }
    protected override void OnGotKeyboardFocus(KeyboardFocusChangedEventArgs e) => InvalidateVisual();
    protected override void OnLostKeyboardFocus(KeyboardFocusChangedEventArgs e) => InvalidateVisual();
}

/// <summary>Indicatore di livello orizzontale (verde, giallo, rosso).</summary>
public sealed class Meter : FrameworkElement
{
    double v;
    public Meter() { Height = 3; }
    public void Set(double level) { level = Math.Clamp(level, 0, 1); if (Math.Abs(level - v) < 0.004) return; v = level; InvalidateVisual(); }
    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, h = ActualHeight;
        dc.DrawRectangle(Theme.Dark, null, new Rect(0, 0, w, h));
        double x = v * w;
        dc.DrawRectangle(Theme.Green, null, new Rect(0, 0, Math.Min(x, w * 0.7), h));
        if (x > w * 0.7) dc.DrawRectangle(Brushes.Gold, null, new Rect(w * 0.7, 0, Math.Min(x, w * 0.9) - w * 0.7, h));
        if (x > w * 0.9) dc.DrawRectangle(Theme.Red, null, new Rect(w * 0.9, 0, x - w * 0.9, h));
    }
}
