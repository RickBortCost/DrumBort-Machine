// Vst3Editor.cs — Finestra di un plugin VST 3: la sua interfaccia è disegnata dal plugin dentro
// una finestra figlia (HWND) ospitata in WPF. Alla chiusura lo stato del plugin va nel progetto.

using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using DrumBort.Host;

namespace DrumBort.Win;

public sealed class Vst3Editor : Window
{
    static readonly Dictionary<Vst3.Plugin, Vst3Editor> open = new();
    readonly Vst3.Plugin plug;
    readonly Host host;
    readonly Action onClose;
    readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromMilliseconds(300) };
    int lastW, lastH;

    /// <summary>Apre (o porta in primo piano) la finestra del plugin.</summary>
    public static void Open(Window? owner, Vst3.Plugin p, JsonObject dev, Action onClose)
    {
        if (open.TryGetValue(p, out var w)) { w.Activate(); return; }
        var e = new Vst3Editor(p, onClose) { Owner = owner };
        open[p] = e;
        e.Show();
    }

    /// <summary>Chiude la finestra del plugin (plugin tolto dalla catena).</summary>
    public static void CloseFor(Vst3.Plugin p) { if (open.TryGetValue(p, out var w)) w.Close(); }

    Vst3Editor(Vst3.Plugin p, Action onClose)
    {
        plug = p; this.onClose = onClose;
        Title = p.Name;
        ResizeMode = ResizeMode.NoResize;
        SizeToContent = SizeToContent.WidthAndHeight;
        Background = Theme.Bg;
        ShowInTaskbar = false;
        host = new Host(p) { Width = 400, Height = 240 };
        Content = host;
        host.Opened += (w, h) => Fit(w, h);
        host.Failed += () =>
        {
            Content = new System.Windows.Controls.Border { Padding = new Thickness(20), Child = Txt.Make("Questo plugin non ha una finestra propria: usa le manopole nel DEVICE.", 13, Theme.Dim) };
            Width = 420; Height = 120; SizeToContent = SizeToContent.Manual;
        };
        timer.Tick += (_, _) => { if (plug.EditorSize(out int w, out int h) && (w != lastW || h != lastH)) Fit(w, h); };
        timer.Start();
        Closed += (_, _) =>
        {
            timer.Stop();
            open.Remove(plug);
            plug.CloseEditor();
            onClose();
        };
    }

    /// <summary>Dimensione del plugin (pixel fisici) → unità WPF.</summary>
    void Fit(int w, int h)
    {
        if (w <= 0 || h <= 0) return;
        lastW = w; lastH = h;
        var dpi = System.Windows.Media.VisualTreeHelper.GetDpi(this);
        host.Width = w / dpi.DpiScaleX;
        host.Height = h / dpi.DpiScaleY;
    }

    /// <summary>Finestra figlia Win32 in cui il plugin disegna.</summary>
    sealed class Host : HwndHost
    {
        readonly Vst3.Plugin plug;
        IntPtr hwnd;
        public event Action<int, int>? Opened;
        public event Action? Failed;
        public Host(Vst3.Plugin p) { plug = p; }

        protected override HandleRef BuildWindowCore(HandleRef parent)
        {
            hwnd = CreateWindowEx(0, "static", "", WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN, 0, 0, 400, 240, parent.Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            Dispatcher.BeginInvoke(() =>
            {
                if (plug.OpenEditor(hwnd, out int w, out int h)) Opened?.Invoke(w, h);
                else Failed?.Invoke();
            }, DispatcherPriority.Loaded);
            return new HandleRef(this, hwnd);
        }
        protected override void DestroyWindowCore(HandleRef h) { plug.CloseEditor(); DestroyWindow(h.Handle); }

        const int WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_CLIPCHILDREN = 0x02000000;
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateWindowEx(int ex, string cls, string name, int style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
        [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
    }
}
